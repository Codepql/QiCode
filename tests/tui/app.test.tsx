import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../../src/config/types.js";
import type { ChatRequest, Provider } from "../../src/llm/client.js";
import type { EnvironmentContext } from "../../src/prompt/sections.js";
import { App, initializeAgentRuntime } from "../../src/tui/app.js";

const providerConfig: ProviderConfig = {
  name: "test",
  protocol: "openai",
  model: "test-model",
  base_url: "https://example.com",
  api_key: "test-key",
  thinking: false,
};

describe("App", () => {
  it("renders the real input for a single configured provider", () => {
    const view = render(<App providers={[providerConfig]} />);

    expect(view.lastFrame()).toContain("QiCode v0.1.0");
    expect(view.lastFrame()).toContain("test-model");
    expect(view.lastFrame()).not.toContain("openai · test-model");
    expect(view.lastFrame()).not.toContain("Static preview only");
  });

  it("builds a runtime prompt from the detected environment and selected model", async () => {
    const provider = fakeProvider([]);
    const environment: EnvironmentContext = {
      workDir: "/workspace",
      os: "linux",
      arch: "x64",
      shell: "bash",
      isGitRepo: true,
      gitBranch: "main",
      model: "",
      date: "2026-08-03",
    };

    const runtime = await initializeAgentRuntime(
      providerConfig,
      "/workspace",
      vi.fn(async () => provider),
      vi.fn(async () => environment),
    );

    expect(runtime.provider).toBe(provider);
    expect(runtime.systemPrompt).toContain("工作目录：/workspace");
    expect(runtime.systemPrompt).toContain("模型：test-model");
  });

  it("reuses one stable system prompt across user turns", async () => {
    const requests: ChatRequest[] = [];
    const runtimeFactory = vi.fn(async () => ({
      provider: fakeProvider(requests),
      systemPrompt: "stable-system-prompt",
    }));
    const view = render(
      <App
        providers={[providerConfig]}
        workDir="/workspace"
        runtimeFactory={runtimeFactory}
      />,
    );

    view.stdin.write("first");
    await waitFor(() => (view.lastFrame() ?? "").includes("first"));
    view.stdin.write("\r");
    await waitFor(() => requests.length === 1);
    view.stdin.write("second");
    await waitFor(() => (view.lastFrame() ?? "").includes("second"));
    view.stdin.write("\r");
    await waitFor(() => requests.length === 2);

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.systemPrompt)).toEqual([
      "stable-system-prompt",
      "stable-system-prompt",
    ]);
    view.unmount();
  });

  it("renders the active permission mode in the input area", () => {
    const view = render(
      <App providers={[providerConfig]} workDir="/workspace" />,
    );

    expect(view.lastFrame()).toContain("default");
    view.unmount();
  });
});

function fakeProvider(requests: ChatRequest[]): Provider {
  return {
    config: providerConfig,
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "done" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for App state");
}
