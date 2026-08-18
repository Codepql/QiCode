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
  /**
   * Hook 在第 2 阶段才做语义校验。配置层保留原始条目，避免单条坏规则
   * 阻止其它合法规则进入 Hook 校验器。
   */
  hooks: unknown[];
}

export interface MCPConfig {
  mcp_servers: MCPServerConfig[];
}
