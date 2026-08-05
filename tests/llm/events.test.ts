import { describe, expect, expectTypeOf, it } from "vitest";
import type { ProviderConfig } from "../../src/config/types.js";
import type { ChatRequest, Provider } from "../../src/llm/client.js";
import type { StreamEvent } from "../../src/llm/events.js";

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
        yield { type: "tool_call_start", toolId: "tool-1", toolName: "ReadFile" };
        yield { type: "tool_call_delta", toolId: "tool-1", argumentsDelta: "{\"file_" };
        yield {
          type: "tool_call_complete",
          toolId: "tool-1",
          toolName: "ReadFile",
          arguments: { file_path: "README.md" },
        };
        yield { type: "usage", inputTokens: 4, outputTokens: 1 };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const request: ChatRequest = {
      systemPrompt: "You are QiCode.",
      messages: [],
      tools: [
        {
          name: "ReadFile",
          description: "读取文件",
          inputSchema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      ],
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(request)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "tool_call_start", toolId: "tool-1", toolName: "ReadFile" },
      { type: "tool_call_delta", toolId: "tool-1", argumentsDelta: "{\"file_" },
      {
        type: "tool_call_complete",
        toolId: "tool-1",
        toolName: "ReadFile",
        arguments: { file_path: "README.md" },
      },
      { type: "usage", inputTokens: 4, outputTokens: 1 },
      { type: "done", stopReason: "end_turn" },
    ]);
    expectTypeOf(provider.stream(request)).toMatchTypeOf<
      AsyncIterable<StreamEvent>
    >();
  });
});
