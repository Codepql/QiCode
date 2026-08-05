import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import { createProvider } from "../../src/llm/client.js";
import { OpenAIProvider } from "../../src/llm/openai.js";

describe("createProvider", () => {
  const base = { name: "main", model: "model", base_url: "https://example.com", api_key: "key", thinking: false };

  it("creates providers for the two supported protocols", async () => {
    await expect(
      createProvider({ ...base, protocol: "anthropic" }, vi.fn() as typeof fetch),
    ).resolves.toBeInstanceOf(AnthropicProvider);
    await expect(
      createProvider({ ...base, protocol: "openai" }, vi.fn() as typeof fetch),
    ).resolves.toBeInstanceOf(OpenAIProvider);
  });

  it("defensively rejects unknown protocols", async () => {
    await expect(
      createProvider({ ...base, protocol: "custom" } as never),
    ).rejects.toThrow("Unsupported provider protocol");
  });
});
