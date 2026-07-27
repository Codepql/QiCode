import type { ProviderConfig } from "../config/types.js";
import type { ConversationMessage } from "../conversation/types.js";
import { ProviderResponseError } from "./errors.js";
import { assertSuccessfulResponse, normalizeFetchError, requireResponseBody } from "./http.js";
import { parseSSE } from "./sse.js";
import type { ChatRequest, Provider, StreamEvent } from "./types.js";
import { buildProviderUrl } from "./url.js";

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
              ...request.messages.map(toOpenAIMessage),
            ],
            stream: true,
            stream_options: { include_usage: true },
          }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
      await assertSuccessfulResponse(response);
    } catch (error) {
      normalizeFetchError(error, request.signal);
    }

    let doneEmitted = false;
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

          const stopReason = stringValue(choice?.finish_reason);
          if (stopReason && !doneEmitted) {
            yield { type: "done", stopReason };
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

function toOpenAIMessage(message: ConversationMessage): Record<string, string> {
  return {
    role: message.role,
    content: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
  };
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
