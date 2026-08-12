import type { Tool } from "./types.js";

type ToolProtocol = "anthropic" | "openai";

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  readonly #discovered = new Set<string>();

  register(tool: Tool): void {
    this.#tools.set(tool.name, tool);
    if (!tool.deferred) this.#discovered.delete(tool.name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  listTools(): Tool[] {
    return [...this.#tools.values()];
  }

  listToolsForModel(): Tool[] {
    return this.listTools().filter(
      (tool) => !tool.deferred || this.#discovered.has(tool.name),
    );
  }

  getDeferredToolNames(): string[] {
    return this.getDeferredTools()
      .filter((tool) => !this.#discovered.has(tool.name))
      .map((tool) => tool.name);
  }

  getDeferredTools(): Tool[] {
    return this.listTools().filter((tool) => tool.deferred === true);
  }

  searchDeferred(query: string, maxResults = 5): Tool[] {
    const normalized = query.trim().toLowerCase();
    if (normalized === "") return [];
    const limit = Math.max(1, maxResults);
    return this.getDeferredTools().filter(
      (tool) =>
        !this.#discovered.has(tool.name) &&
        `${tool.name}\n${tool.description}`.toLowerCase().includes(normalized),
    ).slice(0, limit);
  }

  findDeferredByNames(names: readonly string[]): Tool[] {
    return names.flatMap((name) => {
      const tool = this.#tools.get(name);
      return tool?.deferred === true ? [tool] : [];
    });
  }

  markDiscovered(name: string): void {
    if (this.#tools.get(name)?.deferred === true) this.#discovered.add(name);
  }

  isDiscovered(name: string): boolean {
    return this.#discovered.has(name);
  }

  getAllSchemas(protocol: ToolProtocol = "anthropic"): Record<string, unknown>[] {
    return this.listToolsForModel().map((tool) => {
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
