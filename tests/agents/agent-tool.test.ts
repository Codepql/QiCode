import { describe, expect, it } from "vitest";
import { AgentTool } from "../../src/agents/agent-tool.js";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { SubAgentRunner } from "../../src/agents/runner.js";
import { TaskManager } from "../../src/agents/task-manager.js";

const foreground: AgentDefinition = {
  name: "foreground",
  description: "foreground",
  maxTurns: 2,
  permissionMode: "default",
  background: false,
};
const background: AgentDefinition = { ...foreground, name: "background", background: true };

describe("AgentTool", () => {
  it("runs a foreground role and rejects an unknown role", async () => {
    const tool = createTool();

    await expect(tool.execute({ description: "review", prompt: "inspect", subagent_type: "foreground" }, context()))
      .resolves.toEqual({ output: "finished", isError: false });
    await expect(tool.execute({ description: "review", prompt: "inspect", subagent_type: "missing" }, context()))
      .resolves.toEqual({ output: "Unknown SubAgent role: missing", isError: true });
  });

  it("creates, queries, and cancels a background role", async () => {
    const tool = createTool();
    const created = await tool.execute({ description: "background", prompt: "inspect", subagent_type: "background" }, context());
    const taskId = /created: ([\w-]+)/.exec(created.output)?.[1];
    expect(taskId).toBeDefined();

    await expect(tool.execute({ operation: "status", task_id: taskId }, context()))
      .resolves.toMatchObject({ isError: false });
    await expect(tool.execute({ operation: "cancel", task_id: taskId }, context()))
      .resolves.toMatchObject({ isError: false });
  });

  it("returns a ToolResult when the background task limit is reached", async () => {
    const tool = createTool(1);
    await tool.execute({ description: "first", prompt: "inspect", subagent_type: "background" }, context());

    await expect(tool.execute({ description: "second", prompt: "inspect", subagent_type: "background" }, context()))
      .resolves.toMatchObject({ isError: true, output: "Too many active or unconsumed background tasks" });
  });
});

function createTool(maxRetainedTasks?: number): AgentTool {
  const fakeRunner = {
    run: async (request: { definition: AgentDefinition; signal?: AbortSignal }) => {
      if (!request.definition.background) {
        return { finalText: "finished", stopReason: "completed" as const, usage: {} };
      }
      await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { finalText: "", stopReason: "interrupted" as const, usage: {} };
    },
  } as unknown as SubAgentRunner;
  const taskManager = new TaskManager({
    runner: fakeRunner,
    ...(maxRetainedTasks === undefined ? {} : { maxRetainedTasks }),
  });
  return new AgentTool({
    definitions: () => [foreground, background],
    runner: () => fakeRunner,
    taskManager: () => taskManager,
  });
}

function context() {
  return { workDir: process.cwd() };
}
