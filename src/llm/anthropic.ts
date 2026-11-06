import type { ProviderConfig } from "../config/types.js";
import type { ConversationMessage } from "../conversation/types.js";
import {
  assertSuccessfulResponse,
  buildProviderUrl,
  normalizeFetchError,
  parseSSE,
  ProviderResponseError,
  StreamProtocolError,
  requireResponseBody,
  type ChatRequest,
  type Provider,
} from "./client.js";
import type { StreamEvent } from "./events.js";
import { parseToolArguments } from "./tool-arguments.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;
const THINKING_BUDGET_TOKENS = 4096;

type FetchLike = typeof fetch;

export class AnthropicProvider implements Provider {
  constructor(
    readonly config: ProviderConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (config.protocol !== "anthropic") {
      throw new TypeError("AnthropicProvider requires protocol=anthropic");
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(buildProviderUrl(this.config.base_url, "messages"), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.api_key,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(this.buildRequestBody(request)),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      await assertSuccessfulResponse(response);
    } catch (error) {
      normalizeFetchError(error, request.signal);
    }

    const thinkingBlocks = new Map<number, { thinking: string; signature: string }>();
    const toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>();
    let stopReason: string | undefined;
    let doneEmitted = false;
    try {
      for await (const message of parseSSE(
        requireResponseBody(response),
        request.signal === undefined ? {} : { signal: request.signal },
      )) {
        const payload = parseJsonRecord(message.data);
        const type = stringValue(payload.type);

        if (type === "message_start") {
          const usage = recordValue(recordValue(payload.message)?.usage);
          yield {
            type: "usage",
            inputTokens: numberValue(usage?.input_tokens) ?? 0,
            outputTokens: numberValue(usage?.output_tokens) ?? 0,
            cacheReadInputTokens: numberValue(usage?.cache_read_input_tokens) ?? 0,
            cacheCreationInputTokens:
              numberValue(usage?.cache_creation_input_tokens) ?? 0,
          };
        } else if (type === "content_block_start") {
          const index = numberValue(payload.index);
          const block = recordValue(payload.content_block);
          if (index !== undefined && stringValue(block?.type) === "thinking") {
            thinkingBlocks.set(index, {
              thinking: stringValue(block?.thinking) ?? "",
              signature: stringValue(block?.signature) ?? "",
            });
          } else if (index !== undefined && stringValue(block?.type) === "tool_use") {
            const id = stringValue(block?.id);
            const name = stringValue(block?.name);
            if (!id || !name) {
              throw new ProviderResponseError("Anthropic tool use block is missing id or name");
            }
            toolCalls.set(index, { id, name, argumentsJson: "" });
            yield { type: "tool_call_start", toolId: id, toolName: name };
          }
        } else if (type === "content_block_delta") {
          const index = numberValue(payload.index);
          const delta = recordValue(payload.delta);
          const deltaType = stringValue(delta?.type);
          if (deltaType === "text_delta") {
            const text = stringValue(delta?.text);
            if (text) yield { type: "text_delta", text };
          } else if (deltaType === "thinking_delta") {
            const thinking = stringValue(delta?.thinking) ?? "";
            if (index !== undefined) getThinking(thinkingBlocks, index).thinking += thinking;
            if (thinking) yield { type: "thinking_delta", thinking };
          } else if (deltaType === "signature_delta" && index !== undefined) {
            getThinking(thinkingBlocks, index).signature += stringValue(delta?.signature) ?? "";
          } else if (deltaType === "input_json_delta" && index !== undefined) {
            const argumentsDelta = stringValue(delta?.partial_json) ?? "";
            const toolCall = toolCalls.get(index);
            if (toolCall) {
              toolCall.argumentsJson += argumentsDelta;
              if (argumentsDelta) {
                yield { type: "tool_call_delta", toolId: toolCall.id, argumentsDelta };
              }
            }
          }
        } else if (type === "content_block_stop") {
          const index = numberValue(payload.index);
          const block = index === undefined ? undefined : thinkingBlocks.get(index);
          if (block) {
            yield {
              type: "thinking_complete",
              thinking: block.thinking,
              signature: block.signature,
            };
            thinkingBlocks.delete(index!);
          }
          const toolCall = index === undefined ? undefined : toolCalls.get(index);
          if (toolCall) {
            yield {
              type: "tool_call_complete",
              toolId: toolCall.id,
              toolName: toolCall.name,
              arguments: parseToolArguments(toolCall.argumentsJson),
            };
            toolCalls.delete(index!);
          }
        } else if (type === "message_delta") {
          const outputTokens = numberAt(payload, "usage", "output_tokens");
          stopReason = stringAt(payload, "delta", "stop_reason") ?? stopReason;
          if (outputTokens !== undefined) yield { type: "usage", outputTokens };
        } else if (type === "message_stop") {
          if (toolCalls.size > 0) throw new StreamProtocolError("Anthropic stream ended with unfinished tool blocks");
          yield stopReason === undefined
            ? { type: "done" }
            : { type: "done", stopReason };
          doneEmitted = true;
        } else if (type === "error") {
          throw new ProviderResponseError("Anthropic stream returned an error event");
        }
      }
    } catch (error) {
      normalizeFetchError(error, request.signal);
    }

    if (!doneEmitted) throw new StreamProtocolError("Anthropic stream closed before message_stop");
  }

  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const maxTokens = request.maxOutputTokens ?? MAX_TOKENS;
    const messages = request.messages.map(toAnthropicMessage);
    markLastUserTailForCache(messages);
    const tools = request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    if (tools && tools.length > 0) {
      Object.assign(tools.at(-1)!, { cache_control: { type: "ephemeral" } });
    }

    return {
      model: this.config.model,
      system: [{
        type: "text",
        text: request.systemPrompt,
        cache_control: { type: "ephemeral" },
      }],
      messages,
      stream: true,
      max_tokens: maxTokens,
      ...(this.config.thinking && maxTokens > 1024
        ? { thinking: { type: "enabled", budget_tokens: Math.min(THINKING_BUDGET_TOKENS, maxTokens - 1) } }
        : {}),
      ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    };
  }
}

function markLastUserTailForCache(messages: Record<string, unknown>[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const lastBlock = message.content.at(-1);
    if (typeof lastBlock === "object" && lastBlock !== null) {
      Object.assign(lastBlock, { cache_control: { type: "ephemeral" } });
    }
    return;
  }
}

function toAnthropicMessage(message: ConversationMessage): Record<string, unknown> {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  > = [];

  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && message.role === "assistant") {
      content.push({
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      });
    } else if (block.type === "tool_use" && message.role === "assistant") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    } else if (block.type === "tool_result" && message.role === "user") {
      content.push({
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    role: message.role,
    content,
  };
}


function getThinking(
  blocks: Map<number, { thinking: string; signature: string }>,
  index: number,
) {
  const block = blocks.get(index) ?? { thinking: "", signature: "" };
  blocks.set(index, block);
  return block;
}

function parseJsonRecord(data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new ProviderResponseError("Anthropic stream contained invalid JSON");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function numberAt(root: Record<string, unknown>, ...path: string[]): number | undefined {
  let value: unknown = root;
  for (const key of path) value = recordValue(value)?.[key];
  return numberValue(value);
}
function stringAt(root: Record<string, unknown>, ...path: string[]): string | undefined {
  let value: unknown = root;
  for (const key of path) value = recordValue(value)?.[key];
  return stringValue(value);
}
