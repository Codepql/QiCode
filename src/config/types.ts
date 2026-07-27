export type Protocol = "anthropic" | "openai";

export interface ProviderConfig {
  name: string;
  protocol: Protocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking: boolean;
}

export interface AppConfig {
  providers: ProviderConfig[];
}
