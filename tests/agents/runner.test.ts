import { describe, expect, it } from "vitest";
import { SubAgentRunner } from "../../src/agents/runner.js";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { ProviderConfig } from "../../src/config/types.js";
import type { Provider } from "../../src/llm/client.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const providerConfig: ProviderConfig = {
  name: "parent",
  protocol: "openai",
  model: "parent-model",
  base_url: "https://example.com/v1",
  api_key: "secret-key",
  thinking: false,
};

const definition: AgentDefinition = {
  name: "reviewer",
  description: "review",
  maxTurns: 2,
  permissionMode: "default",
  background: false,
};

describe("SubAgentRunner", () => {
  it("creates a provider with only the model overridden and returns final text", async () => {
    const providerConfigs: ProviderConfig[] = [];
    const runner = new SubAgentRunner({
      providerConfig,
      registry: new ToolRegistry(),
      systemPrompt: "parent system",
      workDir: process.cwd(),
      providerFactory: async (config) => {
        providerConfigs.push(config);
        return fakeProvider(config, "child result");
      },
    });

    const result = await runner.run({ definition, prompt: "inspect", modelOverride: "child-model" });

    expect(result).toMatchObject({ finalText: "child result", stopReason: "completed" });
    expect(providerConfigs).toEqual([{ ...providerConfig, model: "child-model" }]);
  });

  it("returns a structured error for an empty model override", async () => {
    const runner = new SubAgentRunner({
      providerConfig,
      registry: new ToolRegistry(),
      systemPrompt: "system",
      workDir: process.cwd(),
    });

    await expect(runner.run({ definition, prompt: "inspect", modelOverride: "  " }))
      .resolves.toMatchObject({ stopReason: "error", error: "SubAgent model must be a non-empty string" });
  });
});

function fakeProvider(config: ProviderConfig, text: string): Provider {
  return {
    config,
    async *stream() {
      yield { type: "text_delta", text } as const;
      yield { type: "done" } as const;
    },
  };
}
