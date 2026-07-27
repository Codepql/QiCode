import type { ProviderConfig } from "../config/types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

export function createProvider(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Provider {
  if (config.protocol === "anthropic") return new AnthropicProvider(config, fetchImpl);
  if (config.protocol === "openai") return new OpenAIProvider(config, fetchImpl);
  throw new TypeError(`Unsupported provider protocol: ${String(config.protocol)}`);
}
