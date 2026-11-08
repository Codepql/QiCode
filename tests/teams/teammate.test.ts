import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runTeammate } from "../../src/teammate.js";
import { listMetrics } from "../../src/metrics/run-metrics.js";

const state = vi.hoisted(() => ({ requests: 0, messageCounts: [] as number[] }));
vi.mock("../../src/config/load-config.js", () => ({ loadConfigLayers: async () => ({ providers: [{ name: "fake", model: "fake", protocol: "openai", base_url: "http://localhost", api_key: "unused", thinking: false }], hooks: [] }) }));
vi.mock("../../src/tui/runtime.js", async () => {
  const { ToolRegistry } = await import("../../src/tools/registry.js");
  return { createToolRegistry: () => new ToolRegistry(), initializeAgentRuntime: async (config: unknown) => ({ systemPrompt: "offline", provider: { config, async *stream(request: { messages: unknown[] }) {
    state.requests++; state.messageCounts.push(request.messages.length);
    yield { type: "text_delta", text: `answer ${state.requests}` }; yield { type: "usage", inputTokens: state.requests * 10, outputTokens: 2 }; yield { type: "done", stopReason: "stop" };
  } } }) };
});
vi.mock("../../src/teams/transcript.js", () => ({ saveTranscript: () => {} }));
vi.mock("../../src/teams/file-mailbox.js", () => ({ FileMailbox: class {
  private polls = 0;
  async send() {}
  async *poll() { yield { from: "lead", text: this.polls++ === 0 ? "second task" : "[shutdown]" }; }
} }));
describe("standalone teammate runs", () => {
  it("keeps conversation history but records independent metrics for successive tasks", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-teammate-runs-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workDir);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runTeammate({ teamDir: workDir, memberName: "worker", initialTask: "first task" });
      const runs = listMetrics(workDir);
      expect(runs).toHaveLength(2); expect(new Set(runs.map((run) => run.runId)).size).toBe(2);
      expect(runs.every((run) => run.outcome === "stop" && run.requests === 1)).toBe(true);
      expect(runs.map((run) => run.usage.inputTokens).sort((a, b) => a! - b!)).toEqual([10, 20]);
      expect(state.messageCounts[1]).toBeGreaterThan(state.messageCounts[0]!);
    } finally { output.mockRestore(); cwd.mockRestore(); }
  });
});
