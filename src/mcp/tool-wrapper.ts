import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import type { MCPClient, MCPTool } from "./client.js";

export function toMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizePart(serverName)}__${sanitizePart(toolName)}`;
}

export class MCPToolWrapper implements Tool {
  readonly name: string;
  readonly description: string;
  readonly category = "command" as const;
  readonly deferred = true;
  readonly #client: MCPClient;
  readonly #remoteName: string;
  readonly #inputSchema: Record<string, unknown>;

  constructor(client: MCPClient, serverName: string, tool: MCPTool) {
    this.#client = client;
    this.#remoteName = tool.name;
    this.name = toMcpToolName(serverName, tool.name);
    this.description = tool.description;
    this.#inputSchema = { ...tool.inputSchema };
  }

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: { ...this.#inputSchema },
    };
  }

  async execute(
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      return {
        output: await this.#client.callTool(this.#remoteName, args),
        isError: false,
      };
    } catch (error) {
      return {
        output: `MCP tool error: ${errorMessage(error)}`,
        isError: true,
      };
    }
  }
}

function sanitizePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
