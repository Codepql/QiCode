import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/llm/openai.js";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import { parseToolArguments } from "../../src/llm/tool-arguments.js";
import { Agent } from "../../src/agent/agent.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import type { Provider } from "../../src/llm/client.js";

const config = { name: "test", protocol: "openai" as const, model: "local", base_url: "http://localhost", api_key: "unused-secret", thinking: false };
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function fetchStream(chunks: string[]): typeof fetch { return (async () => new Response(chunks.join(""), { status: 200 })) as typeof fetch; }
async function collect(provider: Provider) { const events = []; for await (const event of provider.stream({ systemPrompt: "test", messages: [] })) events.push(event); return events; }

describe("complete tool requests only", () => {
  it.each(["{", "[]", "null", "42", '"secret-token"'])("rejects malformed/non-object args %s without exposing their contents", (input) => {
    expect(() => parseToolArguments(input)).toThrow("complete JSON object");
  });
  it("rejects EOF without finish_reason or a stream terminal event", async () => {
    const provider = new OpenAIProvider(config, fetchStream([data({ choices: [{ delta: { content: "partial" } }] })]));
    await expect(collect(provider)).rejects.toThrow("terminal event");
  });
  it("does not turn pending tools at [DONE] into normal completion", async () => {
    const provider = new OpenAIProvider(config, fetchStream([data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: "WriteFile", arguments: "{}" } }] } }] }), "data: [DONE]\n\n"]));
    await expect(collect(provider)).rejects.toThrow("finish_reason");
  });
  it.each(["length", "max_tokens"])("never executes valid-looking write arguments when stopped by %s", async (reason) => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({ name: "WriteFile", category: "write", description: "write", schema: () => ({ input_schema: { type: "object" } }), execute: async () => { executed = true; return { output: "written", isError: false }; } });
    const conversation = new Conversation(); conversation.addUserMessage("修复文件");
    const provider = reason === "length" ? new OpenAIProvider(config, fetchStream([data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "write", function: { name: "WriteFile", arguments: "{}" } }] }, finish_reason: reason }] })]))
      : new AnthropicProvider({ ...config, protocol: "anthropic" }, fetchStream([
        data({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "write", name: "WriteFile" } }),
        data({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
        data({ type: "content_block_stop", index: 0 }), data({ type: "message_delta", delta: { stop_reason: reason } }), data({ type: "message_stop" }),
      ]));
    const events = [];
    for await (const event of new Agent({ provider, registry, conversation, workDir: process.cwd(), systemPrompt: "test", checker: new PermissionChecker(process.cwd(), "bypassPermissions"), execution: { maxProviderRetries: 0 } }).run()) events.push(event);
    expect(executed).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "loop_complete", stopReason: "length" });
    expect(conversation.getMessages().flatMap((message) => message.content).some((block) => block.type === "tool_use")).toBe(false);
  });
});
