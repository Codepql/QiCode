import type { ProviderConfig } from "../config/types.js";
import type { ConversationMessage } from "../conversation/types.js";
import {
  assertSuccessfulResponse,
  buildProviderUrl,
  normalizeFetchError,
  parseSSE,
  ProviderResponseError,
  requireResponseBody,
  type ChatRequest,
  type Provider,
} from "./client.js";
import type { StreamEvent } from "./events.js";

type FetchLike = typeof fetch;

export class OpenAIProvider implements Provider {
  constructor(
    readonly config: ProviderConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (config.protocol !== "openai") {
      throw new TypeError("OpenAIProvider requires protocol=openai");
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        buildProviderUrl(this.config.base_url, "chat/completions"),
        {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.api_key}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              { role: "system", content: request.systemPrompt },
              ...request.messages.flatMap(toOpenAIMessages),
            ],
            stream: true,
            stream_options: { include_usage: true },
            ...(request.tools === undefined || request.tools.length === 0
              ? {}
              : {
                  tools: request.tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  })),
                }),
          }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
      await assertSuccessfulResponse(response);
    } catch (error) {
      normalizeFetchError(error, request.signal);
    }

    let doneEmitted = false;
    const toolCalls = new Map<number, OpenAIToolCall>();
    try {
      for await (const message of parseSSE(
        requireResponseBody(response),
        request.signal === undefined ? {} : { signal: request.signal },
      )) {
        if (message.data.trim() === "[DONE]") {
          if (!doneEmitted) yield { type: "done" };
          return;
        }

        const payload = parseJsonRecord(message.data);
        const usage = recordValue(payload.usage);
        const inputTokens = numberValue(usage?.prompt_tokens);
        const outputTokens = numberValue(usage?.completion_tokens);
        if (inputTokens !== undefined || outputTokens !== undefined) {
          yield {
            type: "usage",
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          };
        }

        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        for (const choiceValue of choices) {
          const choice = recordValue(choiceValue);
          const delta = recordValue(choice?.delta);
          const text = stringValue(delta?.content);
          if (text) yield { type: "text_delta", text };

          const deltaToolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
          for (const toolCallValue of deltaToolCalls) {
            const toolCallDelta = recordValue(toolCallValue);
            const index = numberValue(toolCallDelta?.index);
            if (index === undefined) continue;
            const functionValue = recordValue(toolCallDelta?.function);
            const existing = toolCalls.get(index) ?? {
              id: "",
              name: "",
              argumentsJson: "",
              started: false,
            };
            const id = stringValue(toolCallDelta?.id);
            const name = stringValue(functionValue?.name);
            const argumentsDelta = stringValue(functionValue?.arguments) ?? "";
            if (id) existing.id = id;
            if (name) existing.name = name;
            existing.argumentsJson += argumentsDelta;
            toolCalls.set(index, existing);
            if (!existing.started && existing.id && existing.name) {
              existing.started = true;
              yield { type: "tool_call_start", toolId: existing.id, toolName: existing.name };
            }
            if (existing.started && argumentsDelta) {
              yield { type: "tool_call_delta", toolId: existing.id, argumentsDelta };
            }
          }

          const stopReason = stringValue(choice?.finish_reason);
          if (stopReason && !doneEmitted) {
            for (const toolCall of toolCalls.values()) {
              if (!toolCall.id || !toolCall.name) {
                throw new ProviderResponseError("OpenAI tool call is missing id or function name");
              }
              yield {
                type: "tool_call_complete",
                toolId: toolCall.id,
                toolName: toolCall.name,
                arguments: parseToolArguments(toolCall.argumentsJson),
              };
            }
            yield {
              type: "done",
              stopReason: stopReason === "tool_calls" || toolCalls.size > 0 ? "tool_use" : stopReason,
            };
            doneEmitted = true;
          }
        }
      }
    } catch (error) {
      normalizeFetchError(error, request.signal);
    }

    if (!doneEmitted) yield { type: "done" };
  }
}

interface OpenAIToolCall {
  id: string;
  name: string;
  argumentsJson: string;
  started: boolean;
}

function toOpenAIMessages(message: ConversationMessage): Record<string, unknown>[] {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolUses = message.content.filter((block) => block.type === "tool_use");
  const toolResults = message.content.filter((block) => block.type === "tool_result");

  if (message.role === "assistant" && toolUses.length > 0) {
    return [{
      role: "assistant",
      content: text || null,
      tool_calls: toolUses.map((toolUse) => ({
        id: toolUse.id,
        type: "function",
        function: {
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input),
        },
      })),
    }];
  }
  if (message.role === "user" && toolResults.length > 0) {
    return toolResults.map((toolResult) => ({
      role: "tool",
      tool_call_id: toolResult.toolUseId,
      content: toolResult.content,
    }));
  }
  return [{ role: message.role, content: text }];
}

function parseJsonRecord(data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new ProviderResponseError("OpenAI stream contained invalid JSON");
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

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  if (argumentsJson.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(argumentsJson);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  return {};
}
