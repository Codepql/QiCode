import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunMetrics, formatMetrics, endpointIdentity, recordMetrics, loadMetrics, listMetrics } from "../../src/metrics/run-metrics.js";
import { measuredProvider } from "../../src/metrics/provider.js";
import { resolveBudget } from "../../src/agent/budgets.js";
import type { Provider } from "../../src/llm/client.js";
import type { StreamEvent } from "../../src/llm/events.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { forceCompact } from "../../src/compact/compact.js";
import { RecoveryState } from "../../src/compact/recovery.js";

const identity = { model: "fake", protocol: "anthropic", contextWindow: 32768, maxOutput: 8192, budgetSource: "conservative" };
const config = { name: "fake", model: "fake", protocol: "anthropic" as const, base_url: "http://localhost", api_key: "secret", thinking: false };
describe("local performance metadata", () => {
  it("does not count compaction output as the user's first visible text", () => {
    let now = 0; const metrics = new RunMetrics(identity, undefined, () => now);
    const summary = metrics.start("request", { purpose: "compaction" }); now = 10; metrics.first(summary, true); metrics.end(summary);
    expect(metrics.summary().firstTextMs).toBeNull();
    const main = metrics.start("request", { purpose: "main" }); now = 50; metrics.first(main, true); metrics.end(main); metrics.finish("stop");
    expect(metrics.summary().firstTextMs).toBe(50); expect(metrics.summary().spans[0]?.firstText).toBe(10);
  });
  it("closes a timed-out request even when the underlying stream never responds to abort", async () => {
    vi.useFakeTimers();
    try {
      const metrics = new RunMetrics(identity); const controller = new AbortController();
      const provider: Provider = { config, stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) };
      const pending = measuredProvider(provider, metrics, "main", undefined, 1, { controller, milliseconds: 50 }).stream({ systemPrompt: "", messages: [], signal: controller.signal })[Symbol.asyncIterator]().next();
      const assertion = expect(pending).rejects.toThrow("idle timeout"); await vi.advanceTimersByTimeAsync(50); await assertion;
      expect(metrics.summary().spans[0]?.status).toBe("timeout");
    } finally { vi.useRealTimers(); }
  });
  it("records manual compaction gains and respects the same output budget", async () => {
    const conversation = new Conversation(); for (let i = 0; i < 12; i++) conversation.addUserMessage("history".repeat(1000));
    const metrics = new RunMetrics(identity); const budget = resolveBudget("fake", {}, {}, { maxOutput: 128 });
    const provider: Provider = { config, async *stream(request) { expect(request.maxOutputTokens).toBe(128); yield { type: "text_delta", text: "Observed earlier work; continue verification." }; yield { type: "usage", inputTokens: 100, outputTokens: 20 }; yield { type: "done" }; } };
    const result = await forceCompact(conversation, provider, new RecoveryState(), [], undefined, metrics, budget);
    expect(result.compacted).toBe(true); const summary = metrics.summary();
    expect(summary.compactions.successful).toBe(1); expect(summary.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    const compact = summary.spans.find((span) => span.kind === "compaction")!;
    expect(compact.fields.trigger).toBe("manual"); expect(compact.fields.afterTokens).toBeLessThan(compact.fields.beforeTokens!); expect(compact.fields.keptMessages).toBeGreaterThan(0);
    expect(summary.spans.find((span) => span.kind === "request")?.fields.purpose).toBe("compaction");
  });
  it("unions overlapping approvals and leaves nested request/compaction durations separate", () => {
    let now = 0; const metrics = new RunMetrics(identity, undefined, () => now);
    const request = metrics.start("request", { requestId: "one", attempt: 1 }); now = 10;
    const a = metrics.start("permission"); now = 20; const b = metrics.start("permission"); now = 40;
    metrics.end(a); now = 60; metrics.end(b); now = 100; metrics.end(request); metrics.finish("stop");
    expect(metrics.summary()).toMatchObject({ elapsedMs: 100, approvalMs: 50, activeMs: 50, firstTextMs: null });
  });
  it("merges cumulative and output-only usage per attempt, then adds distinct attempts", () => {
    const metrics = new RunMetrics(identity); const first = metrics.start("request", { requestId: "r", attempt: 1 });
    metrics.usage(first, { inputTokens: 10, cacheReadInputTokens: 20, outputTokens: 0 });
    metrics.usage(first, { outputTokens: 3 }); metrics.usage(first, { outputTokens: 3 }); metrics.end(first, "failed");
    const second = metrics.start("request", { requestId: "r", attempt: 2 }); metrics.usage(second, { inputTokens: 12, outputTokens: 5 }); metrics.end(second); metrics.finish("stop");
    expect(metrics.events.filter((event) => event.type === "usage")).toHaveLength(3);
    expect(metrics.summary()).toMatchObject({ requests: 1, attempts: 2, usage: { inputTokens: 22, outputTokens: 8, cacheReadInputTokens: 20 }, usageIncomplete: false });
  });
  it("distinguishes tool-only first events from first visible text and stores no payload", async () => {
    let now = 0; const metrics = new RunMetrics(identity, undefined, () => now);
    const provider: Provider = { config, async *stream() { now = 10; yield { type: "thinking_delta", thinking: "private thinking" }; now = 15; yield { type: "tool_call_complete", toolId: "t", toolName: "ReadFile", arguments: { file_path: "secret.txt" } }; now = 20; yield { type: "usage", inputTokens: 8 }; yield { type: "done" }; } };
    for await (const _ of measuredProvider(provider, metrics, "main").stream({ systemPrompt: "private prompt", messages: [] })) { /* observe */ }
    metrics.finish("stop");
    expect(metrics.summary().spans[0]).toMatchObject({ firstEvent: 10, status: "completed" });
    expect(metrics.summary().firstTextMs).toBeNull();
    const data = JSON.stringify(metrics.events); expect(data).not.toMatch(/private|secret|file_path|thinking_delta/);
    expect(metrics.events.find((event) => event.type === "usage")).toMatchObject({ usage: { inputTokens: 8 } });
  });
  it("records text, missing terminals, thrown streams and cancellation without changing events", async () => {
    const metrics = new RunMetrics(identity); const controller = new AbortController();
    const provider: Provider = { config, async *stream() { yield { type: "text_delta", text: "hello" }; controller.abort(); throw new Error("cancelled"); } };
    const events: StreamEvent[] = [];
    await expect(async () => { for await (const event of measuredProvider(provider, metrics, "main").stream({ systemPrompt: "", messages: [], signal: controller.signal })) events.push(event); }).rejects.toThrow("cancelled");
    expect(events).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(metrics.summary().firstTextMs).not.toBeNull(); expect(metrics.summary().spans[0]?.status).toBe("cancelled");
    const noTerminal: Provider = { config, async *stream() { yield { type: "text_delta", text: "partial" }; } };
    for await (const _ of measuredProvider(noTerminal, metrics, "compaction").stream({ systemPrompt: "", messages: [] })) { /* observe */ }
    expect(metrics.summary().spans[1]?.status).toBe("unknown");
  });
  it("survives metric writer failure and never replays a request", async () => {
    let calls = 0; const metrics = new RunMetrics(identity, () => { throw new Error("disk full"); });
    const provider: Provider = { config, async *stream() { calls++; yield { type: "done" }; } };
    for await (const _ of measuredProvider(provider, metrics, "main").stream({ systemPrompt: "", messages: [] })) { /* observe */ }
    metrics.finish("stop"); expect(calls).toBe(1); expect(metrics.summary().warning).toContain("保存失败");
  });
  it("loads a damaged or abruptly terminated record as incomplete rather than zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "qicode-metrics-")); const metrics = recordMetrics(dir, identity);
    metrics.start("request"); const path = join(dir, ".qicode", "metrics", `${metrics.runId}.jsonl`);
    appendFileSync(path, JSON.stringify({ version: 1, runId: metrics.runId, atMs: 3, timestamp: "now", type: "usage", spanId: "x", usage: null }) + '\n{"partial":');
    expect(loadMetrics(dir, metrics.runId)).toMatchObject({ outcome: "unknown", elapsedMs: null, activeMs: null, usageIncomplete: true });
    expect(loadMetrics(dir, metrics.runId)?.warning).toContain("损坏"); expect(listMetrics(dir)).toHaveLength(1);
    expect(readFileSync(path, "utf8")).not.toContain("api_key");
    expect(() => loadMetrics(dir, "../secret")).toThrow();
  });
  it("shows running in memory and separates read range evidence from response bodies", () => {
    const metrics = new RunMetrics(identity); expect(metrics.summary().outcome).toBe("running");
    metrics.read({ path: "src/example.ts", version: "hash", startLine: 10, endLine: 20, totalLines: 100, toolId: "t", kind: "repeat" }); metrics.finish("stop");
    expect(formatMetrics(metrics.summary())).toContain("src/example.ts:10-20"); expect(formatMetrics(metrics.summary())).toContain("费用未知");
  });
  it("hashes endpoint credentials and uses configured model budgets without inheriting another model", () => {
    expect(endpointIdentity("https://user:password@example.com/v1?key=secret")).toBe(endpointIdentity("https://example.com/v1"));
    const caps = { large: { contextWindow: 200000, maxOutput: 16000 } };
    expect(resolveBudget("large", caps)).toMatchObject({ source: "configured", contextWindow: 200000, maxOutput: 16000 });
    expect(resolveBudget("small", caps)).toMatchObject({ source: "conservative", contextWindow: 32768, maxOutput: 8192 });
    expect(resolveBudget("small", caps, {}, { contextWindow: 16000 })).toMatchObject({ source: "override", contextWindow: 16000, maxOutput: 4000 });
    expect(() => resolveBudget("bad", {}, {}, { contextWindow: 100, maxOutput: 100 })).toThrow();
  });
});
