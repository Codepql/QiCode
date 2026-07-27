import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";

const encoder = new TextEncoder();
const config = {
  name: "claude",
  protocol: "anthropic" as const,
  model: "claude-test",
  base_url: "https://api.anthropic.com",
  api_key: "secret-key",
  thinking: true,
};

describe("AnthropicProvider", () => {
  it("maps request history and extended thinking", async () => {
    let captured: [string | URL | Request, RequestInit | undefined] | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = [input, init];
      return response([
        event({ type: "message_start", message: { usage: { input_tokens: 7 } } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
        event({ type: "message_delta", usage: { output_tokens: 3 } }),
        event({ type: "message_stop" }),
      ]);
    }) as typeof fetch;
    const provider = new AnthropicProvider(config, fetchImpl);

    const events = await collect(provider.stream({
      systemPrompt: "system",
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old", signature: "old-sig", hidden: true },
          { type: "text", text: "old answer" },
        ],
      }],
    }));

    expect(captured).toBeDefined();
    const [url, init] = captured!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toMatchObject({ "x-api-key": "secret-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "claude-test",
      thinking: { type: "enabled", budget_tokens: 4096 },
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "old", signature: "old-sig" },
        { type: "text", text: "old answer" },
      ] }],
    });
    expect(events).toEqual([
      { type: "usage", inputTokens: 7 },
      { type: "thinking_delta", thinking: "reason" },
      { type: "thinking_complete", thinking: "reason", signature: "sig" },
      { type: "text_delta", text: "answer" },
      { type: "usage", outputTokens: 3 },
      { type: "done" },
    ]);
  });
});

function event(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function response(chunks: string[]): Response {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } }), { status: 200 });
}
async function collect(iterable: AsyncIterable<unknown>) {
  const values = []; for await (const value of iterable) values.push(value); return values;
}
