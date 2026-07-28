import type { Tool } from "./types.js";

type ToolProtocol = "anthropic" | "openai";

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  listTools(): Tool[] {
    return [...this.#tools.values()];
  }

  getAllSchemas(protocol: ToolProtocol = "anthropic"): Record<string, unknown>[] {
    return this.listTools().map((tool) => {
      const schema = tool.schema();
      if (protocol === "anthropic") return schema;

      const inputSchema = schema["input_schema"];
      return {
        type: "function",
        function: {
          name: schema["name"] ?? tool.name,
          description: schema["description"] ?? tool.description,
          parameters: inputSchema ?? {},
        },
      };
    });
  }
}
