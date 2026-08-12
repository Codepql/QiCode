export type Protocol = "anthropic" | "openai";

export interface ProviderConfig {
  name: string;
  protocol: Protocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking: boolean;
}

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface AppConfig {
  providers: ProviderConfig[];
}

export interface MCPConfig {
  mcp_servers: MCPServerConfig[];
}
