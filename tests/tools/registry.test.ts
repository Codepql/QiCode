import { describe, expect, it } from "vitest";
import { BashTool } from "../../src/tools/bash.js";
import { EditFileTool } from "../../src/tools/edit-file.js";
import { GlobTool } from "../../src/tools/glob.js";
import { GrepTool } from "../../src/tools/grep.js";
import { ReadFileTool } from "../../src/tools/read-file.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";
import { WriteFileTool } from "../../src/tools/write-file.js";

function createFakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    category: "read",
    schema: () => ({
      name,
      description: `${name} description`,
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    }),
    execute: async () => ({ output: "ok", isError: false }),
  };
}

describe("ToolRegistry", () => {
  it("registers tools and finds them by name", () => {
    const registry = new ToolRegistry();
    const tool = createFakeTool("ReadFile");

    registry.register(tool);

    expect(registry.get("ReadFile")).toBe(tool);
    expect(registry.get("Unknown")).toBeUndefined();
    expect(registry.listTools()).toEqual([tool]);
  });

  it("replaces a tool when the same name is registered again", () => {
    const registry = new ToolRegistry();
    const first = createFakeTool("ReadFile");
    const second = createFakeTool("ReadFile");

    registry.register(first);
    registry.register(second);

    expect(registry.listTools()).toEqual([second]);
  });

  it("exports Anthropic and OpenAI schema shapes", () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("ReadFile"));

    expect(registry.getAllSchemas("anthropic")).toEqual([
      {
        name: "ReadFile",
        description: "ReadFile description",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ]);
    expect(registry.getAllSchemas("openai")).toEqual([
      {
        type: "function",
        function: {
          name: "ReadFile",
          description: "ReadFile description",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);
  });

  it("returns an empty list before tools are registered", () => {
    expect(new ToolRegistry().getAllSchemas()).toEqual([]);
  });

  it("exports all six real tool definitions", () => {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new EditFileTool());
    registry.register(new BashTool());
    registry.register(new GlobTool());
    registry.register(new GrepTool());

    expect(registry.listTools().map((tool) => tool.name)).toEqual([
      "ReadFile",
      "WriteFile",
      "EditFile",
      "Bash",
      "Glob",
      "Grep",
    ]);
    expect(registry.getAllSchemas("anthropic")).toHaveLength(6);
    expect(registry.getAllSchemas("openai")).toHaveLength(6);
  });

  it("uses Chinese descriptions in every real tool schema", () => {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new EditFileTool());
    registry.register(new BashTool());
    registry.register(new GlobTool());
    registry.register(new GrepTool());

    for (const schema of registry.getAllSchemas("anthropic")) {
      expect(schema["description"]).toMatch(/[\u3400-\u9fff]/);
      const inputSchema = schema["input_schema"] as {
        properties?: Record<string, { description?: string }>;
      };
      for (const property of Object.values(inputSchema.properties ?? {})) {
        expect(property.description).toMatch(/[\u3400-\u9fff]/);
      }
    }
  });
});
