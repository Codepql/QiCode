import type { ToolRegistry } from "./registry.js";
import {
  intArg,
  strArg,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.js";

export class ToolSearchTool implements Tool {
  readonly name = "ToolSearch";
  readonly description = "搜索并按完整名称激活延迟加载的外部工具。";
  readonly category = "read" as const;
  readonly system = true;

  constructor(private readonly registry: ToolRegistry) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "关键词，或 select:<完整工具名> 激活一个或多个工具。",
          },
          max_results: {
            type: "integer",
            description: "关键词检索返回的最大候选数量。",
            default: 5,
          },
        },
        required: ["query"],
      },
    };
  }

  async execute(
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const query = strArg(args, "query").trim();
    if (query === "") {
      return { output: "Error: query is required", isError: true };
    }

    if (query.startsWith("select:")) {
      return this.selectTools(query.slice("select:".length));
    }

    const tools = this.registry.searchDeferred(
      query,
      intArg(args, "max_results", 5),
    );
    if (tools.length === 0) {
      return { output: "No deferred tools matched the query.", isError: false };
    }

    return {
      output: tools.map((tool) =>
        `- ${tool.name}: ${tool.description.slice(0, 100)}`
      ).join("\n"),
      isError: false,
    };
  }

  private selectTools(selection: string): ToolResult {
    const names = selection.split(",").map((name) => name.trim()).filter(Boolean);
    const tools = this.registry.findDeferredByNames(names);
    if (tools.length === 0) {
      return {
        output: `No deferred tools found matching: ${names.join(", ")}`,
        isError: false,
      };
    }

    for (const tool of tools) this.registry.markDiscovered(tool.name);
    return {
      output: tools.map((tool) => JSON.stringify(tool.schema(), null, 2)).join("\n\n"),
      isError: false,
    };
  }
}
