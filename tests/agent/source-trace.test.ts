import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, type AgentConfig } from "../../src/agent/agent.js";
import { isChangeInspection, inspectionReminder } from "../../src/agent/task-intent.js";
import { AutoCompactTrackingState, estimateTokens, manageContext, computeCompactThreshold } from "../../src/compact/compact.js";
import { RecoveryState } from "../../src/compact/recovery.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runSession } from "../../src/session/run-session.js";
import { loadSession } from "../../src/session/session.js";
import type { Provider } from "../../src/llm/client.js";

describe("source tracing and bounded recovery", () => {
  it("treats source tracing as read-only while permitting an explicit follow-up fix", () => {
    const goal = "请从 Enter 开始追踪 src 中的实际实现，找出关键函数及调用关系，并解释工具调用循环的结束条件";
    expect(isChangeInspection(goal)).toBe(true);
    expect(isChangeInspection(goal + "\n然后修复错误")).toBe(false);
    expect(inspectionReminder(goal)).toContain("源码调用链分析");
    expect(inspectionReminder(goal)).toContain("正常/异常结束条件");
    expect(inspectionReminder(goal)).not.toContain("3–5 个主要变化");
  });
  it("bounds the entire recovery attachment, including files, skills and tool names", () => {
    const recovery = new RecoveryState();
    for (let i = 0; i < 5; i++) recovery.recordFileRead(`file-${i}.ts`, "source\n".repeat(20_000));
    for (let i = 0; i < 8; i++) recovery.recordSkillInvocation(`skill-${i}`, "instructions\n".repeat(5000));
    const tools = Array.from({ length: 100 }, (_, i) => `Tool${i}`);
    expect(recovery.buildRecoveryAttachment(tools).length).toBeLessThanOrEqual(4000 * 3.5);
    expect(recovery.buildRecoveryAttachment(tools, 1200).length).toBeLessThanOrEqual(1200 * 3.5);
    expect(recovery.buildRecoveryAttachment(tools, 0)).toBe("");
  });
  it("does not re-inflate a 32k conversation after compaction or immediately summarize again", async () => {
    let requests = 0;
    const provider: Provider = { config: providerConfig, async *stream() { requests++; yield { type: "text_delta", text: "Goal: trace the request lifecycle. Completed: input and tools. Next: verify protocol conversion." }; yield { type: "done" }; } };
    const recovery = new RecoveryState();
    for (let i = 0; i < 5; i++) recovery.recordFileRead(`source-${i}.ts`, "large file\n".repeat(10_000));
    const conversation = new Conversation(); for (let i = 0; i < 12; i++) conversation.addUserMessage("x".repeat(7500));
    const tracking = new AutoCompactTrackingState();
    expect((await manageContext(conversation, provider, 32768, 8192, tracking, recovery, ["ReadFile"])).compacted).toBe(true);
    expect(estimateTokens(conversation)).toBeLessThan(computeCompactThreshold(32768, 8192));
    expect((await manageContext(conversation, provider, 32768, 8192, tracking, recovery, ["ReadFile"])).compacted).toBe(false);
    expect(requests).toBe(1);
  });
  it("records the observed page instead of secretly re-reading the whole file", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-observed-page-"));
    const path = join(workDir, "page.ts"); writeFileSync(path, "unobserved full file content");
    const recovery = new RecoveryState(); const registry = new ToolRegistry();
    registry.register({ name: "ReadFile", description: "page", category: "read", schema: () => ({ input_schema: { type: "object" } }), execute: async () => ({ output: "901| observed tail page", isError: false }) });
    let turn = 0;
    const provider: Provider = { config: providerConfig, async *stream() {
      if (!turn++) yield { type: "tool_call_complete", toolId: "page", toolName: "ReadFile", arguments: { file_path: path, offset: 900, limit: 1 } };
      else yield { type: "text_delta", text: "done" };
      yield { type: "done" };
    } };
    const conversation = new Conversation(); conversation.addUserMessage("追踪代码调用关系");
    for await (const _ of new Agent({ provider, registry, conversation, workDir, systemPrompt: "offline", recoveryState: recovery, checker: new PermissionChecker(workDir) }).run()) { /* consume */ }
    expect(recovery.snapshotFiles()[0]?.content).toBe("901| observed tail page");
  });
  it("journals model and budget metadata without storing a credential or endpoint", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-run-metadata-"));
    const conversation = new Conversation(); conversation.addUserMessage("hello");
    const provider: Provider = { config: providerConfig, async *stream() { yield { type: "text_delta", text: "hello" }; yield { type: "done" }; } };
    const config: AgentConfig = { provider, conversation, registry: new ToolRegistry(), checker: new PermissionChecker(workDir), workDir, systemPrompt: "offline", contextWindow: 32768, maxOutput: 8192 };
    for await (const _ of runSession({ ...config, sessionId: "metadata" })) { /* consume */ }
    const entry = loadSession(workDir, "metadata").find((entry) => entry.type === "run_start_v2")!;
    expect(JSON.parse(entry.content)).toMatchObject({ model: "offline-model", protocol: "openai", contextWindow: 32768, maxOutput: 8192 });
    expect(entry.content).not.toContain("secret"); expect(entry.content).not.toContain("http");
  });
});

const providerConfig = { name: "offline", protocol: "openai" as const, model: "offline-model", api_key: "offline-secret", base_url: "http://unused-endpoint", thinking: false };
