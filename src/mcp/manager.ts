import type { MCPServerConfig } from "../config/types.js";
import { MCPClient, type MCPTool } from "./client.js";

export interface ConnectResult {
  tools: Array<{ serverName: string; tool: MCPTool }>;
  servers: string[];
  errors: Array<{ serverName: string; error: string }>;
  instructions: Array<{ serverName: string; text: string }>;
}

export type MCPClientFactory = (config: MCPServerConfig) => MCPClient;

export class MCPManager {
  readonly #clients = new Map<string, MCPClient>();

  constructor(
    private readonly createClient: MCPClientFactory = (config) => new MCPClient(config),
  ) {}

  async connectAll(configs: readonly MCPServerConfig[]): Promise<ConnectResult> {
    await this.disconnectAll();
    const result: ConnectResult = {
      tools: [],
      servers: [],
      errors: [],
      instructions: [],
    };

    for (const config of configs) {
      const client = this.createClient(config);
      try {
        await client.connect();
        const tools = await client.listTools();
        this.#clients.set(config.name, client);
        result.servers.push(config.name);
        result.tools.push(...tools.map((tool) => ({
          serverName: config.name,
          tool,
        })));

        const instructions = client.getInstructions().trim();
        if (instructions !== "") {
          result.instructions.push({ serverName: config.name, text: instructions });
        }
      } catch (error) {
        await client.disconnect();
        result.errors.push({
          serverName: config.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  getClient(name: string): MCPClient | undefined {
    return this.#clients.get(name);
  }

  async disconnectAll(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((client) => client.disconnect()));
  }
}
