import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { createProvider } from "../../src/providers/create-provider.js";
import { OpenAIProvider } from "../../src/providers/openai.js";

describe("createProvider", () => {
  const base = { name: "main", model: "model", base_url: "https://example.com", api_key: "key", thinking: false };

  it("creates providers for the two supported protocols", () => {
    expect(createProvider({ ...base, protocol: "anthropic" }, vi.fn() as typeof fetch)).toBeInstanceOf(AnthropicProvider);
    expect(createProvider({ ...base, protocol: "openai" }, vi.fn() as typeof fetch)).toBeInstanceOf(OpenAIProvider);
  });

  it("defensively rejects unknown protocols", () => {
    expect(() => createProvider({ ...base, protocol: "custom" } as never)).toThrow("Unsupported provider protocol");
  });
});
