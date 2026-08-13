import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../../src/config/types.js";
import type { ChatRequest, Provider } from "../../src/llm/client.js";
import type { MCPClient } from "../../src/mcp/client.js";
import type { MCPManager } from "../../src/mcp/manager.js";
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
    await waitFor(() => requests.filter((request) => request.systemPrompt === "stable-system-prompt").length === 1);
    view.stdin.write("second");
    await waitFor(() => (view.lastFrame() ?? "").includes("second"));
    view.stdin.write("\r");
    await waitFor(() => requests.filter((request) => request.systemPrompt === "stable-system-prompt").length === 2);

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(requests
      .filter((request) => request.systemPrompt === "stable-system-prompt")
      .map((request) => request.systemPrompt)).toEqual([
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

  it("connects MCP for the session, keeps deferred tools hidden, and reports status", async () => {
    const requests: ChatRequest[] = [];
    const runtimeFactory = vi.fn(async () => ({
      provider: fakeProvider(requests),
      systemPrompt: "system",
    }));
    const client = { callTool: vi.fn(async () => "ok") } as unknown as MCPClient;
    const manager = {
      connectAll: vi.fn(async () => ({
        tools: [{
          serverName: "github",
          tool: {
            name: "create_issue",
            description: "Create an issue",
            inputSchema: { type: "object", properties: {} },
          },
        }],
        servers: ["github"],
        errors: [],
        instructions: [{ serverName: "github", text: "Use issues carefully." }],
      })),
      getClient: vi.fn(() => client),
      disconnectAll: vi.fn(async () => {}),
    };
    const view = render(
      <App
        providers={[providerConfig]}
        mcpServers={[{ name: "github", command: "unused" }]}
        runtimeFactory={runtimeFactory}
        mcpManagerFactory={() => manager as unknown as MCPManager}
      />,
    );

    await waitFor(() => manager.connectAll.mock.calls.length === 1);
    await waitFor(() => manager.getClient.mock.calls.length > 0);
    expect(view.lastFrame()).not.toContain("MCP servers (1):");

    view.stdin.write("/mcp");
    await waitFor(() => (view.lastFrame() ?? "").includes("/mcp"));
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("MCP servers (1):"));
    expect(view.lastFrame()).toContain("github");
    expect(view.lastFrame()).toContain("Tools: 1 total");

    view.stdin.write("hello");
    await waitFor(() => (view.lastFrame() ?? "").includes("hello"));
    view.stdin.write("\r");
    await waitFor(() => requests.filter((request) => request.systemPrompt === "system").length === 1);
    const agentRequest = requests.find((request) => request.systemPrompt === "system");
    expect(agentRequest?.tools?.map((tool) => tool.name)).toContain("ToolSearch");
    expect(agentRequest?.tools?.map((tool) => tool.name)).not.toContain(
      "mcp__github__create_issue",
    );
    expect(agentRequest?.messages.some((message) =>
      message.content.some((block) =>
        block.type === "text" && block.text.includes("# MCP Server: github")
      )
    )).toBe(true);

    view.unmount();
    await waitFor(() => manager.disconnectAll.mock.calls.length === 1);
  });

  it("shows sanitized MCP connection failures without injecting them into model history", async () => {
    const requests: ChatRequest[] = [];
    const manager = {
      connectAll: vi.fn(async () => ({
        tools: [],
        servers: [],
        errors: [{ serverName: "bad", error: "\u001b[31moffline\u001b[0m" }],
        instructions: [],
      })),
      getClient: vi.fn(),
      disconnectAll: vi.fn(async () => {}),
    };
    const view = render(
      <App
        providers={[providerConfig]}
        mcpServers={[{ name: "bad", command: "unused" }]}
        runtimeFactory={vi.fn(async () => ({
          provider: fakeProvider(requests),
          systemPrompt: "system",
        }))}
        mcpManagerFactory={() => manager as unknown as MCPManager}
      />,
    );

    await waitFor(() => (view.lastFrame() ?? "").includes("MCP errors: bad: offline"));
    expect(view.lastFrame()).not.toContain("\u001b[31m");
    view.stdin.write("hello");
    await waitFor(() => (view.lastFrame() ?? "").includes("hello"));
    view.stdin.write("\r");
    await waitFor(() => requests.filter((request) => request.systemPrompt === "system").length === 1);
    const agentRequest = requests.find((request) => request.systemPrompt === "system");
    expect(JSON.stringify(agentRequest?.messages)).not.toContain("offline");
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
