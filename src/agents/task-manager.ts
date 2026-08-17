import { randomUUID } from "node:crypto";
import type {
  SubAgentRequest,
  SubAgentResult,
} from "./runner.js";

export const DEFAULT_MAX_BACKGROUND_TASKS = 2;
export const DEFAULT_MAX_RETAINED_TASKS = 100;
export const DEFAULT_TASK_RESULT_LIMIT_CHARS = 4_000;
export const DEFAULT_MAX_NOTIFICATIONS_PER_DRAIN = 4;

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTaskSnapshot {
  id: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  usage?: SubAgentResult["usage"];
}

export interface TaskNotification {
  taskId: string;
  status: Exclude<TaskStatus, "queued" | "running">;
  summary: string;
}

export interface SubAgentExecutor {
  run(request: SubAgentRequest): Promise<SubAgentResult>;
}

export interface TaskManagerConfig {
  runner: SubAgentExecutor;
  maxConcurrent?: number;
  maxRetainedTasks?: number;
  maxResultChars?: number;
}

interface BackgroundTask extends BackgroundTaskSnapshot {
  request: SubAgentRequest;
  controller: AbortController;
  notified: boolean;
  completion?: Promise<void>;
  removeParentAbortListener?: () => void;
}

/**
 * 仅管理后台任务的状态与资源上限。它不持有 Conversation，也不向模型直接写消息；
 * 第六阶段由 Agent/App 消费 drainNotifications() 的短摘要。
 */
export class TaskManager {
  readonly #tasks = new Map<string, BackgroundTask>();
  readonly #queue: string[] = [];
  readonly #maxConcurrent: number;
  readonly #maxRetainedTasks: number;
  readonly #maxResultChars: number;
  #runningCount = 0;

  constructor(private readonly config: TaskManagerConfig) {
    this.#maxConcurrent = positiveLimit(
      config.maxConcurrent,
      DEFAULT_MAX_BACKGROUND_TASKS,
      "maxConcurrent",
    );
    this.#maxRetainedTasks = positiveLimit(
      config.maxRetainedTasks,
      DEFAULT_MAX_RETAINED_TASKS,
      "maxRetainedTasks",
    );
    this.#maxResultChars = positiveLimit(
      config.maxResultChars,
      DEFAULT_TASK_RESULT_LIMIT_CHARS,
      "maxResultChars",
    );
  }

  create(description: string, request: SubAgentRequest): BackgroundTaskSnapshot {
    this.pruneNotifiedTerminalTasks();
    if (this.#tasks.size >= this.#maxRetainedTasks) {
      throw new Error("Too many active or unconsumed background tasks");
    }
    const task: BackgroundTask = {
      id: randomUUID(),
      description: truncate(description.trim(), 500) || "Background SubAgent task",
      status: "queued",
      createdAt: Date.now(),
      request,
      controller: new AbortController(),
      notified: false,
    };
    this.#tasks.set(task.id, task);
    this.#queue.push(task.id);
    this.bindParentCancellation(task);
    this.startQueuedTasks();
    return snapshot(task);
  }

  get(taskId: string): BackgroundTaskSnapshot | undefined {
    const task = this.#tasks.get(taskId);
    return task === undefined ? undefined : snapshot(task);
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.#tasks.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(snapshot);
  }

  cancel(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (task === undefined || isTerminal(task.status)) return false;
    task.controller.abort();
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.error = "Background task cancelled";
    this.startQueuedTasks();
    return true;
  }

  /** 返回尚未消费的终态通知，并在返回前标记，保证每个任务最多通知一次。 */
  drainNotifications(maxNotifications = DEFAULT_MAX_NOTIFICATIONS_PER_DRAIN): TaskNotification[] {
    const limit = positiveLimit(maxNotifications, DEFAULT_MAX_NOTIFICATIONS_PER_DRAIN, "maxNotifications");
    const notifications: TaskNotification[] = [];
    for (const task of this.#tasks.values()) {
      if (notifications.length >= limit) break;
      if (!isTerminal(task.status) || task.notified) continue;
      task.notified = true;
      notifications.push({
        taskId: task.id,
        status: task.status,
        summary: task.result ?? task.error ?? `Background task ${task.status}`,
      });
    }
    return notifications;
  }

  /** 应用退出使用：先取消所有任务，再至多等待 graceMs 清理。 */
  async cancelAll(graceMs = 2_000): Promise<void> {
    for (const task of this.#tasks.values()) this.cancel(task.id);
    const pending = [...this.#tasks.values()]
      .map((task) => task.completion)
      .filter((completion): completion is Promise<void> => completion !== undefined);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, positiveLimit(graceMs, 2_000, "graceMs"))),
    ]);
  }

  private startQueuedTasks(): void {
    while (this.#runningCount < this.#maxConcurrent && this.#queue.length > 0) {
      const taskId = this.#queue.shift()!;
      const task = this.#tasks.get(taskId);
      if (task === undefined || task.status !== "queued") continue;
      this.#runningCount += 1;
      task.status = "running";
      task.startedAt = Date.now();
      const completion = this.runTask(task).finally(() => {
        this.#runningCount -= 1;
        task.removeParentAbortListener?.();
        this.startQueuedTasks();
      });
      task.completion = completion;
      void completion;
    }
  }

  private async runTask(task: BackgroundTask): Promise<void> {
    try {
      const result = await this.config.runner.run({
        ...task.request,
        signal: task.controller.signal,
      });
      if (task.status === "cancelled") return;
      task.finishedAt = Date.now();
      task.result = truncate(result.finalText, this.#maxResultChars);
      task.usage = { ...result.usage };
      if (result.error !== undefined || result.stopReason === "error" || result.stopReason === "timeout") {
        task.status = "failed";
        task.error = result.error ?? `Background task stopped: ${result.stopReason}`;
      } else if (result.stopReason === "interrupted") {
        task.status = "cancelled";
        task.error = "Background task cancelled";
      } else {
        task.status = "completed";
      }
    } catch (error) {
      if (task.status === "cancelled") return;
      task.status = "failed";
      task.finishedAt = Date.now();
      task.error = error instanceof Error ? error.message : String(error);
    }
  }

  private bindParentCancellation(task: BackgroundTask): void {
    const signal = task.request.signal;
    if (signal === undefined) return;
    const onAbort = (): void => {
      this.cancel(task.id);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    task.removeParentAbortListener = () => signal.removeEventListener("abort", onAbort);
  }

  private pruneNotifiedTerminalTasks(): void {
    for (const [taskId, task] of this.#tasks) {
      if (isTerminal(task.status) && task.notified) this.#tasks.delete(taskId);
    }
  }
}

function snapshot(task: BackgroundTask): BackgroundTaskSnapshot {
  return {
    id: task.id,
    description: task.description,
    status: task.status,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.usage === undefined ? {} : { usage: { ...task.usage } }),
  };
}

function isTerminal(status: TaskStatus): status is Exclude<TaskStatus, "queued" | "running"> {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return limit;
}
