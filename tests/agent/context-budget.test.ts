import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBudget } from "../../src/agent/budgets.js";
import { Agent } from "../../src/agent/agent.js";
import { calibratedContextTokens, computeCompactThreshold, manageContext, AutoCompactTrackingState } from "../../src/compact/compact.js";
import { RecoveryState } from "../../src/compact/recovery.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Provider } from "../../src/llm/client.js";

const official = "https://api.deepseek.com/v1";
const config = { name: "fake", model: "deepseek-v4-flash", protocol: "openai" as const, base_url: official, api_key: "unused", thinking: false };
describe("model capacity and calibrated context", () => {
  it("resolves official catalog, explicit override and unknown proxy separately", () => {
    expect(resolveBudget(config.model, {}, {}, {}, official)).toMatchObject({ contextWindow: 1048576, maxOutput: 8192, source: "catalog" });
    expect(resolveBudget(config.model, { [config.model]: { contextWindow: 65536, maxOutput: 4096 } }, {}, {}, official)).toMatchObject({ contextWindow: 65536, maxOutput: 4096, source: "configured" });
    for (const baseUrl of ["https://proxy.example/v1", "https://api.deepseek.com.evil.test/v1", "http://api.deepseek.com/v1"]) expect(resolveBudget(config.model, {}, {}, {}, baseUrl)).toMatchObject({ contextWindow: 32768, source: "conservative" });
    expect(resolveBudget("unknown-model", {}, {}, {}, official).source).toBe("conservative");
  });
  it("reserves output once with bounded headroom, including large explicit output budgets", () => {
    expect(computeCompactThreshold(1048576, 8192)).toBe(1032192);
    expect(computeCompactThreshold(200000, 8192)).toBe(183616);
    expect(computeCompactThreshold(32768, 8192)).toBe(24576);
    expect(computeCompactThreshold(1048576, 100000)).toBe(948576);
    expect(computeCompactThreshold(1048576, 8192, true)).toBe(1040384);
  });
  it("uses server input plus new messages and adjusts overhead instead of double-counting it", () => {
    const conversation = new Conversation(); conversation.addUserMessage("x".repeat(35000));
    const anchor = { baselineTokens: 2000, anchorCount: 1, overheadTokens: 500, generation: conversation.contextGeneration };
    conversation.addUserMessage("1234567");
    expect(calibratedContextTokens(conversation.getMessages(), anchor, 600, conversation.contextGeneration)).toBe(2102);
    expect(calibratedContextTokens(conversation.getMessages(), anchor, 600, conversation.contextGeneration)).toBeLessThan(10000);
  });
  it("invalidates pre-compaction or pre-restore usage even when message counts are unchanged", async () => {
    const conversation = new Conversation(); conversation.addUserMessage("old"); conversation.addUserMessage("tail");
    const anchor = { baselineTokens: 900000, anchorCount: 2, overheadTokens: 100, generation: conversation.contextGeneration };
    conversation.replaceWithCompacted("short summary", conversation.getMessages().slice(-1));
    let calls = 0; const provider: Provider = { config, async *stream() { calls++; yield { type: "done" }; } };
    expect((await manageContext(conversation, provider, 32768, 8192, new AutoCompactTrackingState(), new RecoveryState(), [], anchor, undefined, undefined, undefined, 100)).compacted).toBe(false);
    expect(calls).toBe(0);
    const beforeRestore = conversation.contextGeneration;
    conversation.restoreMessages(conversation.getMessages()); expect(conversation.contextGeneration).toBeGreaterThan(beforeRestore);
    expect(calibratedContextTokens(conversation.getMessages(), anchor, 100, conversation.contextGeneration)).toBeLessThan(200);
  });
  it("does not compact a 30k conversation under the official 1M model budget", async () => {
    const conversation = new Conversation(); for (let i = 0; i < 12; i++) conversation.addUserMessage("x".repeat(8750));
    let summaries = 0, main = 0;
    const provider: Provider = { config, async *stream(request) { if (request.systemPrompt.startsWith("You summarize")) summaries++; else main++; yield { type: "text_delta", text: "answer" }; yield { type: "usage", inputTokens: 30000, outputTokens: 2 }; yield { type: "done", stopReason: "stop" }; } };
    const workDir = mkdtempSync(join(tmpdir(), "qicode-large-capacity-"));
    const agent = new Agent({ provider, conversation, registry: new ToolRegistry(), checker: new PermissionChecker(workDir), workDir, systemPrompt: "offline" });
    for await (const _ of agent.run()) { /* fake model, no API */ }
    expect(agent.effectiveBudget.source).toBe("catalog"); expect(summaries).toBe(0); expect(main).toBe(1);
  });
});
