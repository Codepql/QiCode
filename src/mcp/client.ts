import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerConfig } from "../config/types.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AnyTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | Transport;

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function expandEnv(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(ENV_REFERENCE, (_match, braced: string, plain: string) =>
    environment[braced ?? plain] ?? ""
  );
}

export class MCPClient {
  readonly name: string;
  readonly #config: MCPServerConfig;
  #client: Client | null = null;
  #transport: AnyTransport | null = null;

  constructor(config: MCPServerConfig) {
    this.name = config.name;
    this.#config = cloneConfig(config);
  }

  // 重要 1
  async connect(): Promise<void> {
    if (this.#client !== null) return;

    const transport = await this.#createTransport();
    const client = new Client({ name: "qicode", version: "0.1.0" }, {});
    this.#transport = transport;
    this.#client = client;

    try {
      // SDK 1.29's concrete HTTP transport is structurally wider than its
      // Transport interface under exactOptionalPropertyTypes.
      await client.connect(transport as Transport);
    } catch (error) {
      this.#client = null;
      this.#transport = null;
      await transport.close().catch(() => {});
      throw error;
    }
  }

  getInstructions(): string {
    return this.#client?.getInstructions() ?? "";
  }

  async listTools(): Promise<MCPTool[]> {
    const client = this.#requireClient();
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: { ...tool.inputSchema },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.#requireClient().callTool({
      name,
      arguments: args,
    });

    if (!("content" in result) || !Array.isArray(result.content)) {
      return serialize(result);
    }
    if (result.content.length === 0) return serialize(result);

    return result.content.map((block) =>
      block.type === "text" ? block.text : serialize(block)
    ).join("\n");
  }

  async disconnect(): Promise<void> {
    const client = this.#client;
    const transport = this.#transport;
    this.#client = null;
    this.#transport = null;

    if (client !== null) {
      await client.close().catch(() => {});
    } else if (transport !== null) {
      await transport.close().catch(() => {});
    }
  }

  // 重要 2
  async #createTransport(): Promise<AnyTransport> {
    if (this.#config.command !== undefined) {
      const transport = new StdioClientTransport({
        command: this.#config.command,
        ...(this.#config.args === undefined ? {} : { args: this.#config.args }),
        env: {
          ...stringEnvironment(process.env),
          ...expandRecord(this.#config.env ?? {}),
        },
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => {});
      return transport;
    }

    if (this.#config.url === undefined) {
      throw new Error(
        `MCP server ${this.name} needs either command or url`,
      );
    }

    const url = parseServerUrl(this.name, this.#config.url);
    const requestInit: RequestInit = {
      headers: expandRecord(this.#config.headers ?? {}),
    };
    return this.#config.transport === "sse"
      ? createLegacySseTransport(url, requestInit)
      : new StreamableHTTPClientTransport(url, { requestInit });
  }

  #requireClient(): Client {
    if (this.#client === null) {
      throw new Error(`MCP server ${this.name} is not connected`);
    }
    return this.#client;
  }
}

function expandRecord(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, expandEnv(value)]),
  );
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function parseServerUrl(serverName: string, value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url;
  } catch {
    throw new Error(`MCP server ${serverName} has an invalid HTTP URL`);
  }
}

async function createLegacySseTransport(
  url: URL,
  requestInit: RequestInit,
): Promise<Transport> {
  // SSE is a compatibility fallback for older servers. Loading it lazily keeps
  // the deprecated SDK symbol out of the default Streamable HTTP path.
  const loaded: unknown = await import("@modelcontextprotocol/sdk/client/sse.js");
  if (!isRecord(loaded) || typeof loaded["SSEClientTransport"] !== "function") {
    throw new Error("The installed MCP SDK does not provide legacy SSE support");
  }
  type LegacySseConstructor = new (
    endpoint: URL,
    options?: { requestInit?: RequestInit },
  ) => Transport;
  const LegacySseTransport = loaded["SSEClientTransport"] as LegacySseConstructor;
  return new LegacySseTransport(url, { requestInit });
}

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneConfig(config: MCPServerConfig): MCPServerConfig {
  return {
    ...config,
    ...(config.args === undefined ? {} : { args: [...config.args] }),
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    ...(config.env === undefined ? {} : { env: { ...config.env } }),
  };
}
