import { Conversation } from "../conversation/conversation.js";
import type {
  ConversationBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../conversation/types.js";
import type { Provider, StreamEvent, ToolDefinition } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { StreamingExecutor } from "./streaming-executor.js";
import type { AgentEvent } from "./events.js";

// Keep a single tool result from consuming the next model request's context.
export const MAX_TOOL_OUTPUT_CHARS = 10_000;

export interface AgentConfig {
  provider: Provider;
  registry: ToolRegistry;
  conversation: Conversation;
  systemPrompt: string;
  workDir: string;
  abortSignal?: AbortSignal;
}

export class Agent {
  constructor(private readonly config: AgentConfig) {}

  async *run(): AsyncGenerator<AgentEvent> {
    const tools = toolDefinitions(this.config.registry);
    const firstResponse = createCollectedResponse();

    yield* this.streamResponse(firstResponse, tools);
    this.commitAssistant(firstResponse);

    if (firstResponse.toolUses.length === 0) {
      yield firstResponse.stopReason === undefined
        ? { type: "loop_complete" }
        : { type: "loop_complete", stopReason: firstResponse.stopReason };
      return;
    }

    const executor = new StreamingExecutor(this.config.registry, {
      workDir: this.config.workDir,
      ...(this.config.abortSignal === undefined ? {} : { abortSignal: this.config.abortSignal }),
    });
    for (const toolUse of firstResponse.toolUses) {
      executor.submit(toolUse.id, toolUse.name, toolUse.input);
    }

    const results = await executor.collectResults();
    const resultBlocks: ToolResultBlock[] = [];
    for (const result of results) {
      const output = truncateToolOutput(result.result.output);
      resultBlocks.push({
        type: "tool_result",
        toolUseId: result.toolId,
        content: output,
        isError: result.result.isError,
      });
    }
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
    yield { type: "turn_complete" };

    // A second model response may summarize tool output, but cannot start another tool batch.
    const finalResponse = createCollectedResponse();
    yield* this.streamResponse(finalResponse, tools, true);
    this.commitAssistant(finalResponse);
    yield finalResponse.stopReason === undefined
      ? { type: "loop_complete" }
      : { type: "loop_complete", stopReason: finalResponse.stopReason };
  }

  private async *streamResponse(
    response: CollectedResponse,
    tools: ToolDefinition[],
    rejectToolCalls = false,
  ): AsyncGenerator<AgentEvent> {
    try {
      for await (const event of this.config.provider.stream({
        systemPrompt: this.config.systemPrompt,
        messages: this.config.conversation.getMessages(),
        ...(tools.length === 0 ? {} : { tools }),
        ...(this.config.abortSignal === undefined ? {} : { signal: this.config.abortSignal }),
      })) {
        const agentEvents = this.recordEvent(response, event, rejectToolCalls);
        for (const agentEvent of agentEvents) yield agentEvent;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
    }
  }

  private recordEvent(
    response: CollectedResponse,
    event: StreamEvent,
    rejectToolCalls: boolean,
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
        if (rejectToolCalls) {
          return [{
            type: "error",
            message: "本章每次请求只执行一批工具，后续工具调用留待第 03 章处理。",
          }];
        }
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
        if (event.stopReason !== undefined) {
          response.stopReason = event.stopReason;
        }
        return [];
      case "tool_call_start":
      case "tool_call_delta":
        return [];
    }
  }

  private commitAssistant(response: CollectedResponse): void {
    const content: ConversationBlock[] = [...response.thinking];
    if (response.text) content.push({ type: "text", text: response.text });
    content.push(...response.toolUses);
    if (content.length > 0) this.config.conversation.addAssistantMessage(content);
  }
}

interface CollectedResponse {
  text: string;
  thinking: ThinkingBlock[];
  toolUses: ToolUseBlock[];
  stopReason?: string;
}

function createCollectedResponse(): CollectedResponse {
  return { text: "", thinking: [], toolUses: [] };
}

function toolDefinitions(registry: ToolRegistry): ToolDefinition[] {
  return registry.listTools().map((tool) => {
    const schema = tool.schema();
    const inputSchema = schema["input_schema"];
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: isRecord(inputSchema) ? inputSchema : {},
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;

  const suffix = "\n[工具输出已截断]";
  return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS - suffix.length)}${suffix}`;
}
