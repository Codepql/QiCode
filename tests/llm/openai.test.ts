import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/llm/openai.js";

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
      { type: "usage", inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("injects tools, joins streamed tool arguments, and maps tool history", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return response([
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "ReadFile", arguments: "{\"file_" } }] }, finish_reason: null }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "path\":\"README.md\"}" } }] }, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;
    const provider = new OpenAIProvider(config, fetchImpl);

    const events = await collect(provider.stream({
      systemPrompt: "system",
      tools: [{ name: "ReadFile", description: "读取文件", inputSchema: { type: "object" } }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "ReadFile", input: { file_path: "old.md" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "old-call", content: "old content", isError: false }] },
      ],
    }));

    expect(JSON.parse(String(captured?.body))).toMatchObject({
      tools: [{ type: "function", function: { name: "ReadFile", description: "读取文件", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: null, tool_calls: [{ id: "old-call", function: { name: "ReadFile", arguments: "{\"file_path\":\"old.md\"}" } }] },
        { role: "tool", tool_call_id: "old-call", content: "old content" },
      ],
    });
    expect(events).toEqual([
      { type: "tool_call_start", toolId: "call-1", toolName: "ReadFile" },
      { type: "tool_call_delta", toolId: "call-1", argumentsDelta: "{\"file_" },
      { type: "tool_call_delta", toolId: "call-1", argumentsDelta: "path\":\"README.md\"}" },
      { type: "tool_call_complete", toolId: "call-1", toolName: "ReadFile", arguments: { file_path: "README.md" } },
      { type: "done", stopReason: "tool_calls" },
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
