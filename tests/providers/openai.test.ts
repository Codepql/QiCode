import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/providers/openai.js";

const encoder = new TextEncoder();
const config = {
  name: "openai",
  protocol: "openai" as const,
  model: "gpt-test",
  base_url: "https://api.openai.com/v1",
  api_key: "secret-key",
  thinking: false,
};

describe("OpenAIProvider", () => {
  it("maps text, usage, finish reason and removes thinking history", async () => {
    let captured: [string | URL | Request, RequestInit | undefined] | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = [input, init];
      return response([
        data({ choices: [{ delta: { content: "hello" }, finish_reason: null }] }),
        data({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;
    const provider = new OpenAIProvider(config, fetchImpl);
    const events = await collect(provider.stream({
      systemPrompt: "system",
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "hidden", signature: "sig", hidden: true },
        { type: "text", text: "visible" },
      ] }],
    }));

    expect(captured).toBeDefined();
    const [url, init] = captured!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-test",
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "visible" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "done", stopReason: "stop" },
    ]);
  });
});

function data(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function response(chunks: string[]): Response {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } }), { status: 200 });
}
async function collect(iterable: AsyncIterable<unknown>) {
  const values = []; for await (const value of iterable) values.push(value); return values;
}
