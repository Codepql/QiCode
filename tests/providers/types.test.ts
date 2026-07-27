import { describe, expect, expectTypeOf, it } from "vitest";
import type { ProviderConfig } from "../../src/config/types.js";
import type {
  ChatRequest,
  Provider,
  StreamEvent,
} from "../../src/providers/types.js";

describe("Provider contract", () => {
  it("supports protocol-independent asynchronous stream events", async () => {
    const config: ProviderConfig = {
      name: "fake",
      protocol: "anthropic",
      model: "fake-model",
      base_url: "https://example.com",
      api_key: "test-key",
      thinking: false,
    };
    const provider: Provider = {
      config,
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "Hello" };
        yield { type: "usage", inputTokens: 4, outputTokens: 1 };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const request: ChatRequest = {
      systemPrompt: "You are QiCode.",
      messages: [],
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(request)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "usage", inputTokens: 4, outputTokens: 1 },
      { type: "done", stopReason: "end_turn" },
    ]);
    expectTypeOf(provider.stream(request)).toMatchTypeOf<
      AsyncIterable<StreamEvent>
    >();
  });
});
