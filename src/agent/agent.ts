import { Conversation } from "../conversation/conversation.js";
import type {
  ConversationBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../conversation/types.js";
import type { Provider } from "../llm/client.js";
import type { StreamEvent, ToolDefinition } from "../llm/events.js";
import { buildPlanModeReminder } from "../prompt/plan-mode.js";
import { PermissionChecker } from "../permissions/checker.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCategory } from "../tools/types.js";
import { StreamingExecutor } from "./streaming-executor.js";
import type { AgentEvent } from "./events.js";

// Keep one tool result from consuming an unbounded amount of model context.
export const MAX_TOOL_OUTPUT_CHARS = 10_000;
export const DEFAULT_MAX_ITERATIONS = 20;
const MAX_CONSECUTIVE_UNKNOWN_TOOL_TURNS = 3;

export interface AgentConfig {
  provider: Provider;
  registry: ToolRegistry;
  conversation: Conversation;
  systemPrompt: string;
  workDir: string;
  abortSignal?: AbortSignal;
  maxIterations?: number;
  permissionChecker?: PermissionChecker;
}

export class Agent {
  constructor(private readonly config: AgentConfig) {}

  async *run(): AsyncGenerator<AgentEvent> {
    const maxIterations = this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const permissionChecker = this.config.permissionChecker ?? new PermissionChecker();
    let consecutiveUnknownToolTurns = 0;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (this.config.abortSignal?.aborted) {
        yield { type: "loop_complete", stopReason: "interrupted" };
        return;
      }

      yield { type: "iteration_start", iteration };
      if (permissionChecker.mode === "plan") {
        this.config.conversation.addSystemReminder(buildPlanModeReminder());
      }
      const response = createCollectedResponse();
      const tools = toolDefinitions(this.config.registry, permissionChecker);
      const streamCompleted = yield* this.streamResponse(response, tools);

      if (!streamCompleted || this.config.abortSignal?.aborted) {
        // An unfinished tool request must not be kept in history without a result.
        this.commitAssistant(response, false);
        yield {
          type: "loop_complete",
          stopReason: this.config.abortSignal?.aborted ? "interrupted" : "error",
        };
        return;
      }

      this.commitAssistant(response);
      if (response.toolUses.length === 0) {
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

      yield* this.executeTools(response.toolUses, permissionChecker);
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
  }

  private async *streamResponse(
    response: CollectedResponse,
    tools: ToolDefinition[],
  ): AsyncGenerator<AgentEvent, boolean> {
    try {
      for await (const event of this.config.provider.stream({
        systemPrompt: this.config.systemPrompt,
        messages: this.config.conversation.getMessages(),
        ...(tools.length === 0 ? {} : { tools }),
        ...(this.config.abortSignal === undefined ? {} : { signal: this.config.abortSignal }),
      })) {
        for (const agentEvent of this.recordEvent(response, event)) yield agentEvent;
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
      return false;
    }
  }

  private recordEvent(response: CollectedResponse, event: StreamEvent): AgentEvent[] {
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
    permissionChecker: PermissionChecker,
  ): AsyncGenerator<AgentEvent> {
    const results: ToolExecution[] = [];

    for (const batch of createExecutionBatches(toolUses, this.config.registry)) {
      const batchResults = await this.executeBatch(batch, permissionChecker);
      results.push(...batchResults);
    }

    const resultBlocks: ToolResultBlock[] = results.map((result) => ({
      type: "tool_result",
      toolUseId: result.toolId,
      content: truncateToolOutput(result.result.output),
      isError: result.result.isError,
    }));
    this.config.conversation.addToolResultsMessage(resultBlocks);

    for (const result of results) {
      yield {
        type: "tool_result",
        toolId: result.toolId,
        toolName: result.toolName,
        output: truncateToolOutput(result.result.output),
        isError: result.result.isError,
        elapsed: result.elapsed,
      };
    }
  }

  private async executeBatch(
    toolUses: readonly ToolUseBlock[],
    permissionChecker: PermissionChecker,
  ): Promise<ToolExecution[]> {
    const executor = new StreamingExecutor(this.config.registry, {
      workDir: this.config.workDir,
      ...(this.config.abortSignal === undefined ? {} : { abortSignal: this.config.abortSignal }),
    });
    const blocked: ToolExecution[] = [];
    for (const toolUse of toolUses) {
      const category = toolCategory(this.config.registry, toolUse.name);
      if (!permissionChecker.allows(category)) {
        blocked.push({
          toolId: toolUse.id,
          toolName: toolUse.name,
          result: {
            output: `Plan mode does not allow ${category} tools.`,
            isError: true,
          },
          elapsed: 0,
        });
      } else {
        executor.submit(toolUse.id, toolUse.name, toolUse.input);
      }
    }

    return [...await executor.collectResults(), ...blocked];
  }

  private commitAssistant(response: CollectedResponse, includeToolUses = true): void {
    const content: ConversationBlock[] = [...response.thinking];
    if (response.text) content.push({ type: "text", text: response.text });
    if (includeToolUses) content.push(...response.toolUses);
    if (content.length > 0) this.config.conversation.addAssistantMessage(content);
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
  permissionChecker: PermissionChecker,
): ToolDefinition[] {
  return registry.listTools().filter((tool) => permissionChecker.allows(tool.category)).map((tool) => {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;

  const suffix = "\n[工具输出已截断]";
  return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS - suffix.length)}${suffix}`;
}
