import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMetrics } from "../../src/metrics/run-metrics.js";
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
  it("uses the child's actual model capability and records its parent independently", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-child-budget-"));
    const runner = new SubAgentRunner({ providerConfig, registry: new ToolRegistry(), systemPrompt: "test", workDir,
      parentRunId: "parent-run", contextWindow: 200000, modelCapabilities: { "child-model": { contextWindow: 16000, maxOutput: 2048 } },
      providerFactory: async (config) => ({ config, async *stream(request) { expect(request.maxOutputTokens).toBe(2048); yield { type: "done", stopReason: "end_turn" }; } }) });
    await expect(runner.run({ definition, prompt: "inspect", modelOverride: "child-model" })).resolves.toMatchObject({ stopReason: "completed" });
    expect(listMetrics(workDir)[0]?.identity).toMatchObject({ model: "child-model", contextWindow: 16000, maxOutput: 2048, budgetSource: "configured", parentRunId: "parent-run" });
  });
  it("stops initialization that ignores cancellation and preserves timeout status", async () => {
    vi.useFakeTimers();
    try {
      const runner = new SubAgentRunner({ providerConfig, registry: new ToolRegistry(), systemPrompt: "test", workDir: mkdtempSync(join(tmpdir(), "qicode-child-timeout-")), timeoutMs: 50, providerFactory: () => new Promise(() => {}) });
      const pending = runner.run({ definition, prompt: "inspect" }); await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toMatchObject({ stopReason: "timeout" });
    } finally { vi.useRealTimers(); }
  });
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
