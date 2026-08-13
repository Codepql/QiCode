import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolSearchTool } from "../../src/tools/tool-search.js";
import type { Tool } from "../../src/tools/types.js";

function deferredTool(name: string, description: string): Tool {
  return {
    name,
    description,
    category: "command",
    deferred: true,
    schema: () => ({
      name,
      description,
      input_schema: { type: "object", properties: {} },
    }),
    execute: async () => ({ output: "unused", isError: false }),
  };
}

describe("ToolSearchTool", () => {
  it("is an always-visible read-only system tool with a bounded search schema", () => {
    const tool = new ToolSearchTool(new ToolRegistry());

    expect(tool).toMatchObject({
      name: "ToolSearch",
      category: "read",
      system: true,
    });
    expect("deferred" in tool).toBe(false);
    expect(tool.schema()).toMatchObject({
      name: "ToolSearch",
      input_schema: {
        required: ["query"],
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", default: 5 },
        },
      },
    });
  });

  it("returns an error for an empty query", async () => {
    const tool = new ToolSearchTool(new ToolRegistry());

    await expect(tool.execute({}, { workDir: process.cwd() })).resolves.toEqual({
      output: "Error: query is required",
      isError: true,
    });
  });

  it("lists keyword matches without activating them", async () => {
    const registry = new ToolRegistry();
    registry.register(deferredTool("mcp__github__issues", "Create GitHub issues"));
    const tool = new ToolSearchTool(registry);

    const result = await tool.execute(
      { query: "github", max_results: 1 },
      { workDir: process.cwd() },
    );

    expect(result).toEqual({
      output: "- mcp__github__issues: Create GitHub issues",
      isError: false,
    });
    expect(registry.isDiscovered("mcp__github__issues")).toBe(false);
  });

  it("activates exact selected tools and returns their schemas", async () => {
    const registry = new ToolRegistry();
    registry.register(deferredTool("mcp__github__create", "Create an issue"));
    registry.register(deferredTool("mcp__github__list", "List issues"));
    const tool = new ToolSearchTool(registry);

    const result = await tool.execute(
      { query: "select:mcp__github__create,mcp__github__list" },
      { workDir: process.cwd() },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('"name": "mcp__github__create"');
    expect(result.output).toContain('"name": "mcp__github__list"');
    expect(registry.isDiscovered("mcp__github__create")).toBe(true);
    expect(registry.isDiscovered("mcp__github__list")).toBe(true);
  });

  it("does not fail or activate anything when exact names do not exist", async () => {
    const registry = new ToolRegistry();
    const tool = new ToolSearchTool(registry);

    await expect(tool.execute(
      { query: "select:not-exist" },
      { workDir: process.cwd() },
    )).resolves.toEqual({
      output: "No deferred tools found matching: not-exist",
      isError: false,
    });
  });
});
