import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
import { ContextTooLongError, type Provider } from "../llm/client.js";
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
} from "../permissions/checker.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCategory } from "../tools/types.js";
import { applyBudget } from "../toolresult/budget.js";
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

export const DEFAULT_MAX_ITERATIONS = 20;
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
  fileHistory?: FileHistory;
  recoveryState?: RecoveryState;
  replacementState?: ContentReplacementState;
  activeSkills?: ReadonlyMap<string, string>;
  toolFilter?: (toolName: string) => boolean;
  hookEngine?: HookEngine;
  transientReminders?: () => readonly string[];
  checker: PermissionChecker;
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision,
  ) => Promise<"allow" | "deny" | "allowAlways">;
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

  constructor(private readonly config: AgentConfig) {
    this.#checker = config.checker;
    this.#onPermissionRequest = config.onPermissionRequest;
    this.#recoveryState = config.recoveryState ?? new RecoveryState();
    this.#replacementState = config.replacementState ?? new ContentReplacementState();
    this.#activeSkills = config.activeSkills ?? new Map();
    this.#toolFilter = config.toolFilter;
    this.#hookActionExecutor = this.createHookActionExecutor();
  }

  async *run(): AsyncGenerator<AgentEvent> {
    const maxIterations = this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const checker = this.#checker;
    let consecutiveUnknownToolTurns = 0;
    let contextRecoveryAttempted = false;

    await this.fireHook("session_start");
    try {
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (this.config.abortSignal?.aborted) {
        yield { type: "loop_complete", stopReason: "interrupted" };
        return;
      }

      yield { type: "iteration_start", iteration };
      const compactResult = await manageContext(
        this.config.conversation,
        this.config.provider,
        this.config.contextWindow ?? 200_000,
        this.config.maxOutput ?? 8_192,
        this.#compactTracking,
        this.#recoveryState,
        this.config.registry.listTools().map((tool) => tool.name),
        this.#usageAnchor,
      );
      if (compactResult.message !== "") {
        yield {
          type: "compact",
          message: compactResult.message,
          ...(compactResult.boundary === undefined ? {} : { boundary: compactResult.boundary }),
        };
      }
      if (compactResult.compacted) this.#usageAnchor = null;

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
        [skillReminder, ...hookReminders, ...transientReminders],
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

      if (streamResult !== "completed" || this.config.abortSignal?.aborted) {
        // An unfinished tool request must not be kept in history without a result.
        this.commitAssistant(response, false);
        yield {
          type: "loop_complete",
          stopReason: this.config.abortSignal?.aborted ? "interrupted" : "error",
        };
        return;
      }

      await this.fireHook("post_receive", { message: response.text });
      this.commitAssistant(response);
      if (response.toolUses.length === 0) {
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
      yield { type: "loop_complete", stopReason: "max_iterations" };
    } finally {
      await this.fireHook("session_end");
    }
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
      applyBudget(requestMessages, this.config.workDir, this.#replacementState),
    );
    const sentMessageCount = messages.length;
    try {
      for await (const event of this.config.provider.stream({
        systemPrompt: this.config.systemPrompt,
        messages: apiConversation.getMessages(),
        ...(tools.length === 0 ? {} : { tools }),
        ...(this.config.abortSignal === undefined ? {} : { signal: this.config.abortSignal }),
      })) {
        for (const agentEvent of this.recordEvent(response, event, sentMessageCount)) yield agentEvent;
      }
      return "completed";
    } catch (error) {
      if (error instanceof ContextTooLongError) return "context_too_long";
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
      return "failed";
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
        this.#usageAnchor = {
          baselineTokens: (event.inputTokens ?? 0)
            + (event.cacheReadInputTokens ?? 0)
            + (event.cacheCreationInputTokens ?? 0)
            + (event.outputTokens ?? 0),
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
      const batchResults = await this.executeBatch(batch, checker);
      results.push(...batchResults);
    }

    await this.recordReadFiles(toolUses, results);
    const resultBlocks: ToolResultBlock[] = results.map((result) => ({
      type: "tool_result",
      toolUseId: result.toolId,
      content: result.result.output,
      isError: result.result.isError,
    }));
    this.config.conversation.addToolResultsMessage(resultBlocks);

    for (const result of results) {
      const toolUse = toolUses.find((item) => item.id === result.toolId);
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
      };
    }
  }

  private async executeBatch(
    toolUses: readonly ToolUseBlock[],
    checker: PermissionChecker,
  ): Promise<ToolExecution[]> {
    const executor = new StreamingExecutor(this.config.registry, {
      workDir: this.config.workDir,
      readFiles: this.#readFiles,
      fileVersions: this.#fileVersions,
      ...(this.config.fileHistory === undefined ? {} : { fileHistory: this.config.fileHistory }),
      ...(this.config.abortSignal === undefined ? {} : { abortSignal: this.config.abortSignal }),
    });
    const executions = new Map<string, ToolExecution>();

    for (const toolUse of toolUses) {
      const tool = this.config.registry.get(toolUse.name);
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
      const decision = checker.check(toolUse.name, category, toolUse.input);

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
        const response = await this.#onPermissionRequest(
          toolUse.name,
          toolUse.input,
          decision,
        );
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
        // allow / allowAlways 都落到正常执行路径
      }

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
      ...(this.config.abortSignal === undefined ? {} : { abortSignal: this.config.abortSignal }),
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
        this.#recoveryState.recordFileRead(absolutePath, await readFile(absolutePath, "utf8"));
      } catch {
        // The tool already returned success; a later read failure only omits recovery context.
      }
    }
  }
}


interface CollectedResponse {
  text: string;
  thinking: ThinkingBlock[];
  toolUses: ToolUseBlock[];
  stopReason?: string;
}

interface ToolExecution {
  toolId: string;
  toolName: string;
  result: { output: string; isError: boolean };
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
