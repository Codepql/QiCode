import { describe, expect, it } from "vitest";
import { Agent, MAX_TOOL_OUTPUT_CHARS } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { Conversation } from "../../src/conversation/conversation.js";
import type { ChatRequest, Provider, StreamEvent } from "../../src/providers/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";

describe("Agent", () => {
  it("streams a normal answer and records it in the conversation", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", text: "你好" }, { type: "done" }]]);
    const conversation = new Conversation();
    conversation.addUserMessage("你好");

    const events = await collect(new Agent({
      provider,
      registry: new ToolRegistry(),
      conversation,
      systemPrompt: "system",
      workDir: process.cwd(),
    }).run());

    expect(events).toEqual([
      { type: "stream_text", text: "你好" },
      { type: "loop_complete" },
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(conversation.getMessages()).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "text", text: "你好" }] },
    ]);
  });

  it("executes one tool batch, sends its result back, then streams the final answer", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call_complete", toolId: "read-1", toolName: "ReadFile", arguments: { file_path: "README.md" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", text: "文件内容已总结。" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile", "README 内容"));
    const conversation = new Conversation();
    conversation.addUserMessage("读取 README");

    const events = await collect(new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir: process.cwd(),
    }).run());

    expect(events.map((event) => event.type)).toEqual([
      "tool_use",
      "tool_result",
      "turn_complete",
      "stream_text",
      "loop_complete",
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "tool_use", id: "read-1" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "read-1", content: "README 内容" }] },
    ]);
    expect(conversation.getMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "文件内容已总结。" }],
    });
  });

  it("does not execute a second batch of tool calls", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call_complete", toolId: "first", toolName: "ReadFile", arguments: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call_complete", toolId: "second", toolName: "ReadFile", arguments: {} },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile", "first result"));
    const conversation = new Conversation();
    conversation.addUserMessage("连续操作");

    const events = await collect(new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir: process.cwd(),
    }).run());

    expect(events).toContainEqual({
      type: "error",
      message: "本章每次请求只执行一批工具，后续工具调用留待第 03 章处理。",
    });
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(1);
  });

  it("truncates tool output before storing and returning it", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call_complete", toolId: "large", toolName: "ReadFile", arguments: {} },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile", "x".repeat(MAX_TOOL_OUTPUT_CHARS + 100)));
    const conversation = new Conversation();
    conversation.addUserMessage("读取大文件");

    const events = await collect(new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir: process.cwd(),
    }).run());

    const result = events.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ type: "tool_result", output: expect.stringContaining("[工具输出已截断]") });
    if (result?.type === "tool_result") expect(result.output).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
    const toolResult = conversation.getMessages()[2]?.content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", content: expect.stringContaining("[工具输出已截断]") });
  });
});

class FakeProvider implements Provider {
  readonly config = { name: "fake", protocol: "openai" as const, model: "fake", base_url: "https://example.com/v1", api_key: "test", thinking: false };
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: StreamEvent[][]) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(request));
    for (const event of this.responses[this.requests.length - 1] ?? []) yield event;
  }
}

function fakeTool(name: string, output: string): Tool {
  return {
    name,
    description: "测试工具",
    category: "read",
    schema: () => ({ input_schema: { type: "object" } }),
    execute: async () => ({ output, isError: false }),
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
