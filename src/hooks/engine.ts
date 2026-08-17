import { evaluateCondition } from "./condition.js";
import type {
  HookAction,
  HookActionExecutor,
  HookContext,
  HookResult,
  HookRule,
} from "./types.js";

const MAX_NOTIFICATION_BYTES = 32 * 1024;
const MAX_NOTIFICATION_ITEM_BYTES = 8 * 1024;

/**
 * Hook 的运行时状态中心。它不拥有 Agent、React、命令或网络能力：只负责
 * 规则匹配、once 去重、异步任务追踪和等待下一次模型请求消费的通知队列。
 */
export class HookEngine {
  readonly #firedOnce = new Set<string>();
  readonly #notifications: string[] = [];
  readonly #pendingTasks = new Set<Promise<void>>();
  #notificationBytes = 0;

  constructor(
    private readonly hooks: readonly HookRule[],
    private readonly actionExecutor?: HookActionExecutor,
  ) {}

  async fire(
    event: HookContext["event"],
    context: Omit<HookContext, "event"> = {},
    actionExecutor = this.actionExecutor,
  ): Promise<HookResult[]> {
    const results: HookResult[] = [];
    const fullContext: HookContext = { event, ...context };

    for (const hook of this.hooks) {
      if (hook.event !== event || !evaluateCondition(hook.condition, fullContext)) continue;
      if (hook.once && this.#firedOnce.has(onceKey(hook))) continue;
      if (hook.once) this.#firedOnce.add(onceKey(hook));

      if (hook.async) {
        this.startAsync(hook, { ...fullContext, background: true }, actionExecutor);
        results.push({ output: "(async)", success: true, reject: false });
        continue;
      }

      const result = await this.runHook(hook, fullContext, false, actionExecutor);
      if (result === undefined) continue;
      results.push(result);
      if (result.output !== "") this.recordNotification(result.output);
      if (event === "pre_tool_use" && result.reject) break;
    }
    return results;
  }

  async firePreToolHooks(
    toolName: string,
    args: Record<string, unknown>,
    actionExecutor = this.actionExecutor,
  ): Promise<{ rejected: boolean; reason: string }> {
    const filePath = stringArgument(args.file_path) || stringArgument(args.path);
    const results = await this.fire("pre_tool_use", {
      toolName,
      args,
      ...(filePath === "" ? {} : { filePath }),
    }, actionExecutor);
    const rejection = results.find((result) => result.reject);
    return rejection === undefined
      ? { rejected: false, reason: "" }
      : { rejected: true, reason: rejection.output || "Rejected by Hook policy" };
  }

  recordNotification(message: string): void {
    const normalized = message.trim();
    if (normalized === "" || this.#notificationBytes >= MAX_NOTIFICATION_BYTES) return;

    const available = MAX_NOTIFICATION_BYTES - this.#notificationBytes;
    const cap = Math.min(MAX_NOTIFICATION_ITEM_BYTES, available);
    const item = truncateUtf8(normalized, cap);
    if (item === "") return;
    this.#notifications.push(item);
    this.#notificationBytes += Buffer.byteLength(item, "utf8");
  }

  drainNotifications(): string[] {
    const drained = [...this.#notifications];
    this.#notifications.length = 0;
    this.#notificationBytes = 0;
    return drained;
  }

  private startAsync(
    hook: HookRule,
    context: HookContext,
    actionExecutor: HookActionExecutor | undefined,
  ): void {
    const task = this.runHook(hook, context, true, actionExecutor)
      .then((result) => {
        if (result?.output) this.recordNotification(result.output);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.recordNotification(`Async hook error: ${message}`);
      })
      .finally(() => this.#pendingTasks.delete(task));
    this.#pendingTasks.add(task);
  }

  private async runHook(
    hook: HookRule,
    context: HookContext,
    includeIgnoredFailures = false,
    actionExecutor = this.actionExecutor,
  ): Promise<HookResult | undefined> {
    const executed = await this.executeAction(hook.action, context, actionExecutor);
    if (executed.success) {
      return { ...executed, reject: hook.reject };
    }

    if (!hook.reject && hook.onError === "ignore" && !includeIgnoredFailures) return undefined;
    return {
      ...executed,
      reject: hook.reject || hook.onError === "reject",
    };
  }

  private async executeAction(
    action: HookAction,
    context: HookContext,
    actionExecutor: HookActionExecutor | undefined,
  ): Promise<Omit<HookResult, "reject">> {
    if (action.type === "prompt") {
      return { output: action.prompt ?? "", success: true };
    }
    if (actionExecutor === undefined) {
      return {
        output: `${action.type}-type hook configured but no HookActionExecutor registered`,
        success: false,
      };
    }

    try {
      return await actionExecutor.execute(action, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Hook action error: ${message}`, success: false };
    }
  }
}

function onceKey(hook: HookRule): string {
  return hook.id ?? `${hook.event}-${hook.action.type}`;
}

function stringArgument(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const suffix = "\n[Hook output truncated]";
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > contentLimit) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
}
