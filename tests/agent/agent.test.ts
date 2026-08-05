import { describe, expect, it } from "vitest";
import { Agent, MAX_TOOL_OUTPUT_CHARS } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import type { ChatRequest, Provider } from "../../src/llm/client.js";
import type { StreamEvent } from "../../src/llm/events.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";

describe("Agent", () => {
  it("streams a text-only reply and completes after the first iteration", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", text: "hello" }, { type: "done" }]]);
    const conversation = conversationWithUser();

    const events = await collect(agent(provider, new ToolRegistry(), conversation));

    expect(events).toEqual([
      { type: "iteration_start", iteration: 1 },
      { type: "stream_text", text: "hello" },
      { type: "loop_complete" },
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(Conversation.visibleText(conversation.getMessages().at(-1)!)).toBe("hello");
  });

  it("continues across tool batches until the model returns text", async () => {
    const provider = new FakeProvider([
      [toolCall("read-1", "ReadFile"), { type: "done", stopReason: "tool_use" }],
      [toolCall("write-1", "WriteFile"), { type: "done", stopReason: "tool_use" }],
      [{ type: "text_delta", text: "finished" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile", "read result"));
    registry.register(fakeTool("WriteFile", "write result"));
    const conversation = conversationWithUser();

    const events = await collect(agent(provider, registry, conversation));

    expect(provider.requests).toHaveLength(3);
    expect(events.filter((event) => event.type === "iteration_start")).toEqual([
      { type: "iteration_start", iteration: 1 },
      { type: "iteration_start", iteration: 2 },
      { type: "iteration_start", iteration: 3 },
    ]);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(2);
    expect(Conversation.visibleText(conversation.getMessages().at(-1)!)).toBe("finished");
  });

  it("stops when the configured iteration limit is reached", async () => {
    const provider = new FakeProvider([[toolCall("read", "ReadFile"), { type: "done" }]]);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile", "result"));

    const events = await collect(agent(provider, registry, conversationWithUser(), 2));

    expect(provider.requests).toHaveLength(2);
    expect(events).toContainEqual({ type: "error", message: "已达到最大执行轮次，已停止本次任务。" });
    expect(events.at(-1)).toEqual({ type: "loop_complete", stopReason: "max_iterations" });
  });

  it("stops repeated calls to an unknown tool", async () => {
    const provider = new FakeProvider([[toolCall("unknown", "NotRegistered"), { type: "done" }]]);

    const events = await collect(agent(provider, new ToolRegistry(), conversationWithUser()));

    expect(provider.requests).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "loop_complete", stopReason: "unknown_tool" });
  });

  it("keeps partial text but not unpaired tool calls when a provider stream fails", async () => {
    const provider = new ThrowingProvider();
    const conversation = conversationWithUser();

    const events = await collect(agent(provider, new ToolRegistry(), conversation));

    expect(events).toContainEqual({ type: "error", message: "stream failed" });
    expect(events.at(-1)).toEqual({ type: "loop_complete", stopReason: "error" });
    expect(Conversation.visibleText(conversation.getMessages().at(-1)!)).toBe("partial");
  });

  it("truncates tool output before returning it and saving it", async () => {
    const provider = new FakeProvider([
      [toolCall("large", "ReadFile"), { type: "done" }],
      [{ type: "done" }],
    ]);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile", "x".repeat(MAX_TOOL_OUTPUT_CHARS + 100)));
    const conversation = conversationWithUser();

    const events = await collect(agent(provider, registry, conversation));

    const result = events.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ type: "tool_result", output: expect.stringContaining("[工具输出已截断]") });
    if (result?.type === "tool_result") expect(result.output).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
  });

  it("runs adjacent read tools together before a write tool", async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(recordingTool("ReadOne", "read", calls));
    registry.register(recordingTool("ReadTwo", "read", calls));
    registry.register(recordingTool("WriteOne", "write", calls));
    const provider = new FakeProvider([
      [
        toolCall("one", "ReadOne"),
        toolCall("two", "ReadTwo"),
        toolCall("three", "WriteOne"),
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);

    await collect(agent(provider, registry, conversationWithUser()));

    expect(calls).toEqual(["start:ReadOne", "start:ReadTwo", "end:ReadOne", "end:ReadTwo", "start:WriteOne", "end:WriteOne"]);
  });

  it("returns an error result instead of executing write tools in plan mode", async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(recordingTool("WriteOne", "write", calls));
    const provider = new FakeProvider([
      [toolCall("write", "WriteOne"), { type: "done" }],
      [{ type: "done" }],
    ]);
    const conversation = conversationWithUser();

    const events = await collect(agent(
      provider,
      registry,
      conversation,
      undefined,
      new PermissionChecker(process.cwd(), "plan"),
    ));

    expect(calls).toEqual([]);
    expect(events).toContainEqual({
      type: "tool_result",
      toolId: "write",
      toolName: "WriteOne",
      output: "Permission denied: Mode: plan. 此操作已被安全策略拦截和阻止，请告知用户该命令被拒绝，不要描述该命令会做什么。",
      isError: true,
      elapsed: 0,
    });
    expect(Conversation.visibleText(provider.requests[0]!.messages.at(-1)!)).toContain("计划模式已激活");
    expect(provider.requests[0]!.tools).toBeUndefined();
  });
});

class FakeProvider implements Provider {
  readonly config = {
    name: "fake",
    protocol: "openai" as const,
    model: "fake",
    base_url: "https://example.com/v1",
    api_key: "test",
    thinking: false,
  };
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: StreamEvent[][]) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(request));
    for (const event of this.responses[this.requests.length - 1] ?? this.responses[0] ?? []) {
      yield event;
    }
  }
}

class ThrowingProvider implements Provider {
  readonly config = {
    name: "fake",
    protocol: "openai" as const,
    model: "fake",
    base_url: "https://example.com/v1",
    api_key: "test",
    thinking: false,
  };

  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "partial" };
    throw new Error("stream failed");
  }
}

function agent(
  provider: Provider,
  registry: ToolRegistry,
  conversation: Conversation,
  maxIterations?: number,
  checker?: PermissionChecker,
): AsyncIterable<AgentEvent> {
  return new Agent({
    provider,
    registry,
    conversation,
    systemPrompt: "system",
    workDir: process.cwd(),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    // 默认 bypassPermissions：既有"测试时不走 HITL"的预期不变。
    checker: checker ?? new PermissionChecker(process.cwd(), "bypassPermissions"),
  }).run();
}

function conversationWithUser(): Conversation {
  const conversation = new Conversation();
  conversation.addUserMessage("task");
  return conversation;
}

function toolCall(toolId: string, toolName: string): StreamEvent {
  return { type: "tool_call_complete", toolId, toolName, arguments: {} };
}

function fakeTool(name: string, output: string): Tool {
  return {
    name,
    description: "Test tool",
    category: "read",
    schema: () => ({ input_schema: { type: "object" } }),
    execute: async () => ({ output, isError: false }),
  };
}

function recordingTool(
  name: string,
  category: Tool["category"],
  calls: string[],
): Tool {
  return {
    name,
    description: "Recording tool",
    category,
    schema: () => ({ input_schema: { type: "object" } }),
    execute: async () => {
      calls.push(`start:${name}`);
      await Promise.resolve();
      calls.push(`end:${name}`);
      return { output: name, isError: false };
    },
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
