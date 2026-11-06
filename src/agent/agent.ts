import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { discoverInstructions } from "../memory/instructions.js";
import {
  AutoCompactTrackingState,
  forceCompact,
  manageContext,
  type UsageAnchor,
} from "../compact/compact.js";
import { RecoveryState } from "../compact/recovery.js";
import { Conversation } from "../conversation/conversation.js";
import type {
  ConversationBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../conversation/types.js";
import { ContextTooLongError, NetworkError, RateLimitError, StreamProtocolError, TransientProviderError, type Provider } from "../llm/client.js";
import type { FileHistory } from "../filehistory/filehistory.js";
import type { StreamEvent, ToolDefinition } from "../llm/events.js";
import {
  buildPlanModeReminder,
  getPlanPath,
  planFileExists,
} from "../prompt/plan-mode.js";
import {
  PermissionChecker,
  type Decision,
  type PermissionResponse,
} from "../permissions/checker.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCategory, ToolResult, ToolContext } from "../tools/types.js";
import { validateToolInput } from "../tools/validate.js";
import { applyBudget, toolOutputBudget } from "../toolresult/budget.js";
import { buildConversation } from "../toolresult/reconstruct.js";
import { ContentReplacementState } from "../toolresult/state.js";
import { buildActiveSkillsReminder } from "../skills/executor.js";
import { BashTool } from "../tools/bash.js";
import { HookCommandActionExecutor, type HookCommandRequest } from "../hooks/command-action.js";
import { HookEngine } from "../hooks/engine.js";
import { HookHttpActionExecutor, type HookHttpRequest } from "../hooks/http-action.js";
import type { HookActionExecutor, HookContext } from "../hooks/types.js";
import { fetchSafeText } from "../security/safe-fetch.js";
import { StreamingExecutor } from "./streaming-executor.js";
import type { AgentEvent } from "./events.js";
import { DEFAULT_EXECUTION, TaskBudget, abortableDelay, withIdleTimeout, type ExecutionSettings } from "./execution.js";
import { TaskDelivery } from "./delivery.js";
import { inspectionReminder, inspectionRequestsChecks } from "./task-intent.js";
import { taskApprovalEligible } from "../permissions/task-approval.js";
import { withEvents } from "./event-queue.js";

export const DEFAULT_MAX_ITERATIONS = DEFAULT_EXECUTION.maxIterations;
// Kept temporarily for existing consumers; runtime output budgeting is now in toolresult/budget.
export const MAX_TOOL_OUTPUT_CHARS = 10_000;
const MAX_CONSECUTIVE_UNKNOWN_TOOL_TURNS = 3;

export interface AgentConfig {
  provider: Provider;
  registry: ToolRegistry;
  conversation: Conversation;
  systemPrompt: string;
  workDir: string;
  abortSignal?: AbortSignal;
  maxIterations?: number;
  contextWindow?: number;
  maxOutput?: number;
  execution?: Partial<ExecutionSettings>;
  trackDelivery?: boolean;
  onToolStart?: ToolContext["onToolStart"];
  onToolEnd?: ToolContext["onToolEnd"];
  fileHistory?: FileHistory;
  recoveryState?: RecoveryState;
  replacementState?: ContentReplacementState;
  activeSkills?: ReadonlyMap<string, string>;
  toolFilter?: (toolName: string) => boolean;
  hookEngine?: HookEngine;
  transientReminders?: () => readonly string[];
  takeSteering?: () => readonly string[];
  checker: PermissionChecker;
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision,
  ) => Promise<PermissionResponse>;
}

export class Agent {
  readonly #readFiles = new Set<string>();
  readonly #fileVersions = new Map<string, string | null>();
  readonly #checker: PermissionChecker;
  readonly #onPermissionRequest: AgentConfig["onPermissionRequest"];
  readonly #compactTracking = new AutoCompactTrackingState();
  readonly #recoveryState: RecoveryState;
  readonly #replacementState: ContentReplacementState;
  readonly #activeSkills: ReadonlyMap<string, string>;
  readonly #toolFilter: ((toolName: string) => boolean) | undefined;
  readonly #hookActionExecutor: HookActionExecutor;
  #usageAnchor: UsageAnchor | null = null;
  readonly #settings: ExecutionSettings;
  readonly #delivery: TaskDelivery;
  #signal: AbortSignal;
  #budget: TaskBudget | undefined;
  readonly #executedIds = new Set<string>();
  readonly #instructionPaths = new Set<string>();
  readonly #failureCounts = new Map<string, number>();
  readonly #uncertainOperations = new Set<string>();
  #taskApproved = false;

  constructor(private readonly config: AgentConfig) {
    this.#checker = config.checker;
    this.#onPermissionRequest = config.onPermissionRequest;
    this.#recoveryState = config.recoveryState ?? new RecoveryState();
    this.#replacementState = config.replacementState ?? new ContentReplacementState();
    this.#activeSkills = config.activeSkills ?? new Map();
    this.#toolFilter = config.toolFilter;
    this.#hookActionExecutor = this.createHookActionExecutor();
    this.#settings = { ...DEFAULT_EXECUTION, ...config.execution };
    this.#signal = config.abortSignal ?? new AbortController().signal;
    const prompt = config.conversation.getMessages().filter((message) => message.role === "user" && !Conversation.visibleText(message).startsWith("<system-reminder>")).at(-1);
    this.#delivery = new TaskDelivery(prompt ? Conversation.visibleText(prompt) : "", config.workDir, config.checker.mode === "plan");
    for (const source of discoverInstructions(config.workDir)) this.#instructionPaths.add(source.path);
    const calls = new Map<string, ToolUseBlock>();
    for (const message of config.conversation.getMessages()) for (const block of message.content) {
      if (block.type === "tool_use") { this.#executedIds.add(block.id); calls.set(block.id, block); }
      if (block.type === "tool_result" && block.executionState === "unknown") {
        const call = calls.get(block.toolUseId);
        if (call) this.#uncertainOperations.add(JSON.stringify([call.name, call.input]));
      }
    }
  }

  async *run(): AsyncGenerator<AgentEvent> {
    this.#taskApproved = false;
    const maxIterations = this.config.maxIterations ?? this.#settings.maxIterations;
    const checker = this.#checker;
    let consecutiveUnknownToolTurns = 0;
    let contextRecoveryAttempted = false;
    let truncations = 0;
    this.#budget = new TaskBudget(this.#settings.taskTimeoutMs, this.config.abortSignal);
    this.#signal = this.#budget.signal;

    try {
      if (this.config.trackDelivery) await this.#delivery.initialize();
      await this.fireHook("session_start");
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (this.#signal.aborted) {
        if (this.config.trackDelivery) yield { type: "delivery", report: this.#delivery.report(this.#budget.controller.signal.aborted ? "budget_exhausted" : "cancelled") };
        yield { type: "loop_complete", stopReason: this.#budget.controller.signal.aborted ? "task_timeout" : "interrupted" };
        return;
      }

      yield { type: "iteration_start", iteration };
      await this.consumeSteering(this.config.takeSteering?.() ?? []);
      const compactResult = await manageContext(
        this.config.conversation,
        this.config.provider,
        this.config.contextWindow ?? 200_000,
        this.config.maxOutput ?? 8_192,
        this.#compactTracking,
        this.#recoveryState,
        this.config.registry.listTools().map((tool) => tool.name),
        this.#usageAnchor,
        this.#signal,
        applyBudget(this.config.conversation.getMessages(), this.config.workDir, this.#replacementState, toolOutputBudget(this.config.contextWindow ?? 200_000, this.config.maxOutput ?? 8192)),
      );
      if (compactResult.message !== "") {
        yield {
          type: "compact",
          message: compactResult.message,
          ...(compactResult.boundary === undefined ? {} : { boundary: compactResult.boundary }),
        };
      }
      if (compactResult.compacted) this.#usageAnchor = null;
      if (compactResult.blocked) {
        yield { type: "error", message: compactResult.message };
        if (this.config.trackDelivery) yield { type: "delivery", report: this.#delivery.report("blocked") };
        yield { type: "loop_complete", stopReason: "context_too_long" }; return;
      }

      if (checker.mode === "plan") {
        const planPath = getPlanPath(this.config.workDir);
        this.config.conversation.addSystemReminder(
          buildPlanModeReminder(
            planPath,
            planFileExists(planPath),
            iteration,
          ),
        );
      }
      await this.fireHook("turn_start");
      await this.fireHook("pre_send");
      const skillReminder = buildActiveSkillsReminder(this.#activeSkills);
      const hookReminders = this.config.hookEngine?.drainNotifications() ?? [];
      const transientReminders = this.config.transientReminders?.() ?? [];
      const response = createCollectedResponse();
      const tools = toolDefinitions(this.config.registry, checker, this.#toolFilter);
      const streamResult = yield* this.streamResponse(
        response,
        tools,
        [skillReminder, ...hookReminders, ...transientReminders, ...(this.#delivery.readOnlyInspection ? [inspectionReminder(this.#delivery.goal)] : [])],
      );

      if (streamResult === "context_too_long") {
        if (contextRecoveryAttempted) {
          yield { type: "error", message: "Conversation context remains too long after recovery." };
          yield { type: "loop_complete", stopReason: "context_too_long" };
          return;
        }
        contextRecoveryAttempted = true;
        try {
          const result = await forceCompact(
            this.config.conversation,
            this.config.provider,
            this.#recoveryState,
            this.config.registry.listTools().map((tool) => tool.name),
            this.#signal,
          );
          this.#usageAnchor = null;
          yield {
            type: "compact",
            message: `Compacted after context-length error: ${result.message}`,
            ...(result.boundary === undefined ? {} : { boundary: result.boundary }),
          };
          if (!result.compacted) {
            yield { type: "error", message: "Conversation context is too long and no history can be compacted." };
            yield { type: "loop_complete", stopReason: "context_too_long" };
            return;
          }
          continue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          yield { type: "error", message: `Context recovery failed: ${message}` };
          yield { type: "loop_complete", stopReason: "context_too_long" };
          return;
        }
      }

      if (streamResult !== "completed" || this.#signal.aborted) {
        // An unfinished tool request must not be kept in history without a result.
        this.commitAssistant(response, false);
        if (this.config.trackDelivery) yield { type: "delivery", report: this.#delivery.report(this.#budget.controller.signal.aborted ? "budget_exhausted" : this.#signal.aborted ? "cancelled" : "failed") };
        yield {
          type: "loop_complete",
          stopReason: this.#budget.controller.signal.aborted ? "task_timeout" : this.#signal.aborted ? "interrupted" : "error",
        };
        return;
      }

      if (response.stopReason === "length" || response.stopReason === "max_tokens") {
        yield { type: "stream_reset" };
        if (++truncations > this.#settings.maxProviderRetries) {
          yield { type: "error", message: "模型输出连续截断；未执行该响应中的工具，请缩小任务或提高输出预算。" };
          yield { type: "loop_complete", stopReason: "length" }; return;
        }
        this.commitAssistant(response, false);
        this.config.conversation.addSystemReminder("上一响应达到输出上限，工具未执行。请缩短回复并重新发出完整工具参数；不要假设修改已经生效。");
        continue;
      }

      if (response.stopReason === "content_filter" || response.stopReason === "refusal") {
        this.commitAssistant(response, false);
        if (this.config.trackDelivery) yield { type: "delivery", report: this.#delivery.report("blocked") };
        yield { type: "error", message: "模型拒绝或过滤了响应，工具未执行。" };
        yield { type: "loop_complete", stopReason: response.stopReason }; return;
      }

      await this.fireHook("post_receive", { message: response.text });
      this.commitAssistant(response);
      if (response.toolUses.length === 0) {
        const steering = this.config.takeSteering?.() ?? [];
        if (steering.length) {
          await this.consumeSteering(steering);
          yield { type: "turn_complete" }; continue;
        }
        if (this.config.trackDelivery) {
          const continuation = await this.#delivery.continuation();
          if (continuation) { this.config.conversation.addSystemReminder(continuation); yield { type: "turn_complete" }; continue; }
          yield { type: "delivery", report: this.#delivery.report() };
        }
        await this.fireHook("turn_end");
        yield response.stopReason === undefined
          ? { type: "loop_complete" }
          : { type: "loop_complete", stopReason: response.stopReason };
        return;
      }

      const onlyUnknownTools = response.toolUses.every(
        (toolUse) => this.config.registry.get(toolUse.name) === undefined,
      );
      consecutiveUnknownToolTurns = onlyUnknownTools
        ? consecutiveUnknownToolTurns + 1
        : 0;

      yield* this.executeTools(response.toolUses, checker);
      await this.fireHook("turn_end");
      yield { type: "turn_complete" };
      if (this.#delivery.repairRounds >= this.#settings.maxRepairRounds) {
        if (this.config.trackDelivery) yield { type: "delivery", report: this.#delivery.report("failed") };
        yield { type: "error", message: "已达到验证修复轮次上限；保留已生效的修改和失败日志。" };
        yield { type: "loop_complete", stopReason: "verification_failed" }; return;
      }

      if (consecutiveUnknownToolTurns >= MAX_CONSECUTIVE_UNKNOWN_TOOL_TURNS) {
        yield {
          type: "error",
          message: "模型连续请求未注册工具，已停止本次任务。",
        };
        yield { type: "loop_complete", stopReason: "unknown_tool" };
        return;
      }
      }

      yield { type: "error", message: "已达到最大执行轮次，已停止本次任务。" };
      if (this.config.trackDelivery) yield { type: "delivery", report: this.#delivery.report("budget_exhausted") };
      yield { type: "loop_complete", stopReason: "max_iterations" };
    } finally {
      this.#budget.dispose();
      await this.fireHook("session_end");
    }
  }

  private async consumeSteering(messages: readonly string[]): Promise<void> {
    const wasReadOnly = this.#delivery.readOnlyInspection;
    for (const message of messages) {
      this.config.conversation.addUserMessage(message);
      this.#delivery.goal += `\n${message}`;
    }
    if (wasReadOnly && !this.#delivery.readOnlyInspection && this.config.trackDelivery) await this.#delivery.initialize();
  }

  private async *streamResponse(
    response: CollectedResponse,
    tools: ToolDefinition[],
    reminders: readonly string[],
  ): AsyncGenerator<AgentEvent, "completed" | "failed" | "context_too_long"> {
    const messages = this.config.conversation.getMessages();
    const requestMessages = [
      ...messages,
      ...reminders
        .filter((reminder) => reminder !== "")
        .map((reminder) => Conversation.systemReminderMessage(reminder)),
    ];
    const apiConversation = buildConversation(
      applyBudget(requestMessages, this.config.workDir, this.#replacementState, toolOutputBudget(this.config.contextWindow ?? 200_000, this.config.maxOutput ?? 8192)),
    );
    const sentMessageCount = messages.length;
    for (let attempt = 0; ; attempt++) {
      const requestController = new AbortController();
      const signal = AbortSignal.any([this.#signal, requestController.signal]);
      try {
        const stream = this.config.provider.stream({
          maxOutputTokens: this.config.maxOutput ?? 8192,
          systemPrompt: this.config.systemPrompt, messages: apiConversation.getMessages(),
          ...(tools.length === 0 ? {} : { tools }), signal,
        });
        for await (const event of withIdleTimeout(stream, this.#settings.requestIdleTimeoutMs, requestController, signal)) {
          for (const agentEvent of this.recordEvent(response, event, sentMessageCount)) yield agentEvent;
        }
        if (!response.terminal) throw new StreamProtocolError("模型流缺少正常终止事件");
        return "completed";
      } catch (error) {
        if (error instanceof ContextTooLongError) return "context_too_long";
        const retryable = error instanceof StreamProtocolError || error instanceof NetworkError
          || error instanceof RateLimitError || error instanceof TransientProviderError
          || requestController.signal.aborted;
        if (!this.#signal.aborted && retryable && attempt < this.#settings.maxProviderRetries) {
          const delayMs = error instanceof RateLimitError && error.retryAfterSeconds !== undefined
            ? Math.max(0, error.retryAfterSeconds * 1000) : Math.min(1000 * 2 ** attempt, 8000);
          yield { type: "retry", attempt: attempt + 1, delayMs, message: "模型请求失败，正在有限重试；未重放工具操作。" };
          yield { type: "stream_reset" };
          response.text = ""; response.toolUses = []; response.thinking = []; response.terminal = false;
          delete response.stopReason;
          try { await abortableDelay(delayMs, this.#signal); } catch { return "failed"; }
          continue;
        }
        const message = this.#budget?.controller.signal.aborted ? "任务执行预算已用尽。"
          : this.#signal.aborted ? "任务已取消。" : error instanceof Error ? error.message : String(error);
        yield { type: "error", message };
        return "failed";
      }
    }
  }
  private recordEvent(
    response: CollectedResponse,
    event: StreamEvent,
    sentMessageCount: number,
  ): AgentEvent[] {
    switch (event.type) {
      case "text_delta":
        response.text += event.text;
        return [{ type: "stream_text", text: event.text }];
      case "thinking_delta":
        return [{ type: "thinking_text", thinking: event.thinking }];
      case "thinking_complete":
        response.thinking.push({
          type: "thinking",
          thinking: event.thinking,
          signature: event.signature,
          hidden: true,
        });
        return [{
          type: "thinking_complete",
          thinking: event.thinking,
          signature: event.signature,
        }];
      case "tool_call_complete":
        response.toolUses.push({
          type: "tool_use",
          id: event.toolId,
          name: event.toolName,
          input: event.arguments,
        });
        return [{
          type: "tool_use",
          toolId: event.toolId,
          toolName: event.toolName,
          args: event.arguments,
        }];
      case "usage":
        if (event.inputTokens !== undefined || (event.cacheReadInputTokens ?? 0) > 0 || (event.cacheCreationInputTokens ?? 0) > 0) this.#usageAnchor = {
          baselineTokens: (event.inputTokens ?? 0)
            + (event.cacheReadInputTokens ?? 0)
            + (event.cacheCreationInputTokens ?? 0),
          anchorCount: sentMessageCount,
        };
        return [{
          type: "usage",
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
          ...(event.cacheReadInputTokens === undefined
            ? {}
            : { cacheReadInputTokens: event.cacheReadInputTokens }),
          ...(event.cacheCreationInputTokens === undefined
            ? {}
            : { cacheCreationInputTokens: event.cacheCreationInputTokens }),
        }];
      case "done":
        response.terminal = true;
        if (event.stopReason !== undefined) response.stopReason = event.stopReason;
        return [];
      case "tool_call_start":
      case "tool_call_delta":
        return [];
    }
  }

  private async *executeTools(
    toolUses: readonly ToolUseBlock[],
    checker: PermissionChecker,
  ): AsyncGenerator<AgentEvent> {
    const results: ToolExecution[] = [];

    for (const batch of createExecutionBatches(toolUses, this.config.registry)) {
      const batchResults = yield* withEvents<AgentEvent, ToolExecution[]>((emit) => this.executeBatch(batch, checker, emit));
      if (this.config.trackDelivery) await this.#delivery.observe(new Set(batchResults.filter((result) => !result.result.isError && (result.toolName === "EditFile" || result.toolName === "WriteFile")).map((result) => {
        const args = batch.find((call) => call.id === result.toolId)!.input;
        return resolve(this.config.workDir, String(args.file_path));
      })));
      for (const result of batchResults) {
        const call = batch.find((item) => item.id === result.toolId);
        if (call) this.#delivery.record(result.toolName, call.input, result.result);
      }
      results.push(...batchResults);
    }

    await this.recordReadFiles(toolUses, results);
    const resultBlocks: ToolResultBlock[] = results.map((result) => ({
      type: "tool_result",
      toolUseId: result.toolId,
      content: result.result.output,
      isError: result.result.isError,
      ...(result.result.metadata?.status === "unknown" ? { executionState: "unknown" as const } : {}),
    }));
    this.config.conversation.addToolResultsMessage(resultBlocks);

    for (const result of results) {
      const toolUse = toolUses.find((item) => item.id === result.toolId);
      if (toolUse && result.result.isError) {
        const signature = createHash("sha256").update(JSON.stringify([this.#delivery.revision, result.toolName, toolUse.input, result.result.metadata?.exitCode ?? result.result.output.replace(/日志：[^\n]*/g, "日志：[已保留]")])).digest("hex");
        this.#failureCounts.set(signature, (this.#failureCounts.get(signature) ?? 0) + 1);
        if (this.#failureCounts.get(signature)! >= 3) {
          this.config.conversation.addSystemReminder("相同工具错误已重复三次且没有有效进展。不要重试相同参数，请改用其他方案，或明确说明阻塞原因。");
        }
      }
      await this.fireHook("post_tool_use", {
        toolName: result.toolName,
        ...(toolUse === undefined ? {} : { args: toolUse.input }),
        ...(toolUse === undefined ? {} : hookFilePath(toolUse.input)),
        message: result.result.output,
      });
      yield {
        type: "tool_result",
        toolId: result.toolId,
        toolName: result.toolName,
        output: result.result.output,
        isError: result.result.isError,
        elapsed: result.elapsed,
        ...(result.result.metadata ? { metadata: result.result.metadata } : {}),
      };
    }
  }

  private async executeBatch(
    toolUses: readonly ToolUseBlock[],
    checker: PermissionChecker,
    emit: (event: AgentEvent) => void,
  ): Promise<ToolExecution[]> {
    const executor = new StreamingExecutor(this.config.registry, {
      workDir: this.config.workDir,
      readFiles: this.#readFiles,
      fileVersions: this.#fileVersions,
      ...(this.config.fileHistory === undefined ? {} : { fileHistory: this.config.fileHistory }),
      abortSignal: this.#signal,
      commandTimeoutSeconds: this.#settings.commandTimeoutSeconds,
      maxCommandTimeoutSeconds: this.#settings.maxCommandTimeoutSeconds,
      maxLogBytes: this.#settings.toolOutputDiskLimitBytes,
      onToolStart: (toolId, toolName, args) => {
        this.config.onToolStart?.(toolId, toolName, args);
        emit({ type: "tool_start", toolId, toolName, args });
      },
      onToolUpdate: (toolId, toolName, output) => emit({ type: "tool_update", toolId, toolName, output }),
      onToolEnd: (toolId, toolName, result) => this.config.onToolEnd?.(toolId, toolName, result),
    });
    const executions = new Map<string, ToolExecution>();

    for (const toolUse of toolUses) {
      const tool = this.config.registry.get(toolUse.name);
      if (this.#delivery.readOnlyInspection && (tool?.category === "write" || toolUse.name === "Bash" && !inspectionRequestsChecks(this.#delivery.goal) && /^\s*(?:pnpm|npm)(?:\.cmd)?\s+(?:run\s+)?(?:test|build|typecheck|benchmark(?::[\w-]+)?)(?:\s|$)/i.test(String(toolUse.input.command)))) {
        executions.set(toolUse.id, { toolId: toolUse.id, toolName: toolUse.name, elapsed: 0, result: { output: "本次只查看改动，未请求修改或运行验证；该工具未执行。请依据已读取内容总结，注明未运行测试。", isError: true, metadata: { status: "not_executed" } } });
        continue;
      }
      const target = typeof toolUse.input.file_path === "string" ? resolve(this.config.workDir, toolUse.input.file_path) : undefined;
      const newInstructions = target ? discoverInstructions(dirname(target)).filter((source) => !this.#instructionPaths.has(source.path)) : [];
      for (const source of newInstructions) {
        this.#instructionPaths.add(source.path);
        this.config.conversation.addSystemReminder(`Applicable project instructions from ${source.path}:\n${source.content}`);
      }
      if (tool?.category === "write" && newInstructions.length) {
        executions.set(toolUse.id, { toolId: toolUse.id, toolName: toolUse.name, elapsed: 0,
          result: { output: "检测到此前尚未加载的子目录指令，已加入上下文；本次未写入，请按新指令重新判断修改。", isError: true, metadata: { status: "not_executed" } } });
        continue;
      }
      const validation = tool ? validateToolInput(tool, toolUse.input) : undefined;
      if (validation || this.#executedIds.has(toolUse.id) || this.#signal.aborted) {
        executions.set(toolUse.id, { toolId: toolUse.id, toolName: toolUse.name, elapsed: 0,
          result: { output: validation ? `工具参数无效：${validation}` : this.#signal.aborted ? "操作已取消，工具未执行" : "调用 ID 已执行过；禁止重放，请重新检查现场。", isError: true, metadata: { status: "not_executed" } } });
        continue;
      }
      if (tool?.system !== true && this.#toolFilter?.(toolUse.name) === false) {
        executions.set(toolUse.id, {
          toolId: toolUse.id,
          toolName: toolUse.name,
          result: {
            output: `Tool '${toolUse.name}' is not available under the active Skill tool restrictions.`,
            isError: true,
          },
          elapsed: 0,
        });
        continue;
      }
      const hookDecision = await this.config.hookEngine?.firePreToolHooks(
        toolUse.name,
        toolUse.input,
        this.#hookActionExecutor,
      );
      if (hookDecision?.rejected) {
        executions.set(toolUse.id, {
          toolId: toolUse.id,
          toolName: toolUse.name,
          result: {
            output: `Rejected by Hook policy: ${hookDecision.reason}`,
            isError: true,
          },
          elapsed: 0,
        });
        continue;
      }
      const category = toolCategory(this.config.registry, toolUse.name);
      let decision = checker.check(toolUse.name, category, toolUse.input);
      const uncertain = this.#uncertainOperations.has(JSON.stringify([toolUse.name, toolUse.input]));
      if (uncertain && category !== "read" && decision.effect !== "deny") decision = { effect: "ask", reason: "上次同一操作开始后结果未知；请核对现场，再明确决定是否重新执行。" };
      if (decision.effect === "ask" && this.#taskApproved && !uncertain && taskApprovalEligible(toolUse.name, toolUse.input, checker.mode, decision)) decision = { effect: "allow", reason: "Explicit approval for this task" };

      if (decision.effect === "deny") {
        executions.set(toolUse.id, {
          toolId: toolUse.id,
          toolName: toolUse.name,
          result: {
            output: `Permission denied: ${decision.reason}. 此操作已被安全策略拦截和阻止，请告知用户该命令被拒绝，不要描述该命令会做什么。`,
            isError: true,
          },
          elapsed: 0,
        });
        continue;
      }

      if (decision.effect === "ask") {
        if (this.#onPermissionRequest === undefined) {
          // 没有审批回调：安全默认 = 拒绝，绝不静默执行。
          executions.set(toolUse.id, {
            toolId: toolUse.id,
            toolName: toolUse.name,
            result: {
              output: `Permission denied: ${decision.reason}. 此操作已被安全策略拦截和阻止，请告知用户该命令被拒绝，不要描述该命令会做什么。`,
              isError: true,
            },
            elapsed: 0,
          });
          continue;
        }
        this.#budget?.pause();
        let response: PermissionResponse;
        try { response = await this.#onPermissionRequest(
          toolUse.name,
          toolUse.input,
          decision,
        ); } finally { this.#budget?.resume(); }
        if (response === "deny") {
          executions.set(toolUse.id, {
            toolId: toolUse.id,
            toolName: toolUse.name,
            result: { output: "Permission denied by user", isError: true },
            elapsed: 0,
          });
          continue;
        }
        if (response === "allowAlways") {
          checker.allowAlways(toolUse.name, toolUse.input);
        }
        if (response === "allowTask" && !uncertain && taskApprovalEligible(toolUse.name, toolUse.input, checker.mode, decision)) this.#taskApproved = true;
        // allow / allowAlways 都落到正常执行路径
      }

      this.#executedIds.add(toolUse.id);
      executor.submit(toolUse.id, toolUse.name, toolUse.input);
    }

    for (const executed of await executor.collectResults()) {
      executions.set(executed.toolId, executed);
    }

    // 按原始调用序回灌，工具调用与结果按 toolUseId 正确配对。
    const results: ToolExecution[] = [];
    for (const toolUse of toolUses) {
      const execution = executions.get(toolUse.id);
      if (execution !== undefined) results.push(execution);
    }
    return results;
  }

  private async fireHook(
    event: HookContext["event"],
    context: Omit<HookContext, "event"> = {},
  ): Promise<void> {
    await this.config.hookEngine?.fire(event, context, this.#hookActionExecutor);
  }

  private createHookActionExecutor(): HookActionExecutor {
    const command = new HookCommandActionExecutor({
      execute: (request) => this.executeHookCommand(request),
    });
    const http = new HookHttpActionExecutor({
      execute: (request) => this.executeHookHttp(request),
    });
    return {
      async execute(action, context) {
        if (action.type === "command") return command.execute(action, context);
        if (action.type === "http") return http.execute(action, context);
        return { output: `Unsupported Hook action type: ${action.type}`, success: false };
      },
    };
  }

  private async executeHookCommand(request: HookCommandRequest): Promise<{ output: string; isError: boolean }> {
    const denied = await this.authorizeHookAction(
      "HookCommand",
      { command: request.command },
      request.context,
    );
    if (denied !== undefined) return denied;
    return new BashTool().execute({ command: request.command, timeout: request.timeoutSeconds }, {
      workDir: this.config.workDir,
      readFiles: this.#readFiles,
      environment: request.environment,
      maxOutputBytes: request.outputLimitBytes,
      abortSignal: this.#signal,
    });
  }

  private async executeHookHttp(request: HookHttpRequest): Promise<{ output: string; isError: boolean }> {
    const denied = await this.authorizeHookAction(
      "HookHttp",
      { url: request.url },
      request.context,
    );
    if (denied !== undefined) return denied;
    try {
      const output = await fetchSafeText(request.url, {
        timeoutMs: request.timeoutMs,
        maxResponseBytes: request.responseLimitBytes,
        maxRedirects: 3,
        allowLoopback: true,
        method: request.method,
        body: request.body,
        headers: { "content-type": "application/json" },
      });
      return { output, isError: false };
    } catch (error) {
      return {
        output: `Hook HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  private async authorizeHookAction(
    toolName: "HookCommand" | "HookHttp",
    args: Record<string, unknown>,
    context: HookContext,
  ): Promise<{ output: string; isError: boolean } | undefined> {
    const decision = this.#checker.check(toolName, "command", args);
    if (decision.effect === "deny") return { output: `Permission denied: ${decision.reason}`, isError: true };
    if (decision.effect === "allow") return undefined;
    if (context.background) {
      return { output: "Permission denied: asynchronous Hook actions cannot wait for approval", isError: true };
    }
    if (this.#onPermissionRequest === undefined) {
      return { output: `Permission denied: ${decision.reason}`, isError: true };
    }
    const response = await this.#onPermissionRequest(toolName, args, decision);
    if (response === "deny") return { output: "Permission denied by user", isError: true };
    if (response === "allowAlways") this.#checker.allowAlways(toolName, args);
    return undefined;
  }

  private commitAssistant(response: CollectedResponse, includeToolUses = true): void {
    const content: ConversationBlock[] = [...response.thinking];
    if (response.text) content.push({ type: "text", text: response.text });
    if (includeToolUses) content.push(...response.toolUses);
    if (content.length > 0) this.config.conversation.addAssistantMessage(content);
  }

  private async recordReadFiles(
    toolUses: readonly ToolUseBlock[],
    results: readonly ToolExecution[],
  ): Promise<void> {
    const successful = new Set(
      results.filter((result) => !result.result.isError).map((result) => result.toolId),
    );
    for (const toolUse of toolUses) {
      if (toolUse.name !== "ReadFile" || !successful.has(toolUse.id)) continue;
      const filePath = toolUse.input.file_path;
      if (typeof filePath !== "string" || filePath === "") continue;
      try {
        const absolutePath = resolve(this.config.workDir, filePath);
        const result = results.find((result) => result.toolId === toolUse.id);
        if (result) this.#recoveryState.recordFileRead(absolutePath, result.result.output);
      } catch {
        // Recovery is optional and must never replace the actual tool result.
      }
    }
  }
}


interface CollectedResponse {
  terminal?: boolean;
  text: string;
  thinking: ThinkingBlock[];
  toolUses: ToolUseBlock[];
  stopReason?: string;
}

interface ToolExecution {
  toolId: string;
  toolName: string;
  result: ToolResult;
  elapsed: number;
}

function createCollectedResponse(): CollectedResponse {
  return { text: "", thinking: [], toolUses: [] };
}

function toolDefinitions(
  registry: ToolRegistry,
  checker: PermissionChecker,
  toolFilter: ((toolName: string) => boolean) | undefined,
): ToolDefinition[] {
  return registry.listToolsForModel().filter((tool) =>
    tool.system === true
    || (checker.allows(tool.category) && (toolFilter === undefined || toolFilter(tool.name)))
  ).map((tool) => {
    const schema = tool.schema();
    const inputSchema = schema["input_schema"];
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: isRecord(inputSchema) ? inputSchema : {},
    };
  });
}

function createExecutionBatches(
  toolUses: readonly ToolUseBlock[],
  registry: ToolRegistry,
): ToolUseBlock[][] {
  const batches: ToolUseBlock[][] = [];
  let readBatch: ToolUseBlock[] = [];

  for (const toolUse of toolUses) {
    if (toolCategory(registry, toolUse.name) === "read") {
      readBatch.push(toolUse);
      continue;
    }
    if (readBatch.length > 0) {
      batches.push(readBatch);
      readBatch = [];
    }
    batches.push([toolUse]);
  }
  if (readBatch.length > 0) batches.push(readBatch);
  return batches;
}

function toolCategory(registry: ToolRegistry, toolName: string): ToolCategory {
  // Unknown tools are treated as commands so plan mode never accidentally permits them.
  return registry.get(toolName)?.category ?? "command";
}

function hookFilePath(args: Record<string, unknown>): { filePath?: string } {
  const value = args.file_path ?? args.path;
  return typeof value === "string" && value !== "" ? { filePath: value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;

  const suffix = "\n[工具输出已截断]";
  return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS - suffix.length)}${suffix}`;
}
