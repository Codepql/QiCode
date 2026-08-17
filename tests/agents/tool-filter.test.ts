import { describe, expect, it } from "vitest";
import { createSubAgentToolRegistry } from "../../src/agents/tool-filter.js";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";

const definition: AgentDefinition = {
  name: "test",
  description: "test",
  maxTurns: 2,
  permissionMode: "default",
  background: false,
};

describe("createSubAgentToolRegistry", () => {
  it("removes Agent and parent system tools without mutating the parent registry", () => {
    const parent = new ToolRegistry();
    parent.register(tool("ReadFile", "read"));
    parent.register(tool("Agent", "read"));
    parent.register(tool("ParentSystem", "read", true));
    const deferred = tool("Deferred", "read");
    deferred.deferred = true;
    parent.register(deferred);
    parent.markDiscovered("Deferred");

    const child = createSubAgentToolRegistry(parent, definition);

    expect(child.listTools().map((item) => item.name)).toEqual(["ReadFile", "Deferred", "ToolSearch"]);
    expect(child.isDiscovered("Deferred")).toBe(true);
    expect(parent.listTools().map((item) => item.name)).toEqual(["ReadFile", "Agent", "ParentSystem", "Deferred"]);
    expect(parent.isDiscovered("Deferred")).toBe(true);
  });

  it("applies background, allowlist, then denylist", () => {
    const parent = new ToolRegistry();
    parent.register(tool("ReadFile", "read"));
    parent.register(tool("Glob", "read"));
    parent.register(tool("WriteFile", "write"));

    const child = createSubAgentToolRegistry(parent, {
      ...definition,
      background: true,
      tools: ["ReadFile", "WriteFile"],
      disallowedTools: ["ReadFile"],
    });

    expect(child.listTools().map((item) => item.name)).toEqual(["ToolSearch"]);
  });
});

function tool(name: string, category: Tool["category"], system = false): Tool {
  return {
    name,
    description: name,
    category,
    ...(system ? { system: true } : {}),
    schema: () => ({ input_schema: { type: "object" } }),
    execute: async () => ({ output: name, isError: false }),
  };
}
