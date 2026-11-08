import React from "react";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import { taskApprovalEligible } from "../../src/permissions/task-approval.js";
import { PermissionDialog } from "../../src/tui/permission-dialog.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ContentReplacementState } from "../../src/toolresult/state.js";
import { applyBudget, toolOutputBudget } from "../../src/toolresult/budget.js";
import { AutoCompactTrackingState, manageContext } from "../../src/compact/compact.js";
import { RecoveryState } from "../../src/compact/recovery.js";
import type { Provider } from "../../src/llm/client.js";
import type { ConversationMessage } from "../../src/conversation/types.js";

const config = { name: "fake", protocol: "openai" as const, model: "fake", api_key: "unused", base_url: "http://unused", thinking: false };
const workspace = () => mkdtempSync(join(tmpdir(), "qicode-task-approval-"));
describe("task approvals and ineffective compaction", () => {
  it("makes Enter approve ordinary steps for the task, while Y stays single-use", async () => {
    const complete = vi.fn();
    const view = render(<PermissionDialog toolName="Bash" argsSummary="node task.js" reason="Mode: default" allowTask onComplete={complete} />);
    expect(view.lastFrame()).toContain("Enter/T 批准本任务"); view.stdin.write("\r");
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("allowTask")); view.unmount();
    const once = vi.fn(); const single = render(<PermissionDialog toolName="Bash" argsSummary="node task.js" reason="Mode: default" allowTask onComplete={once} />);
    single.stdin.write("y"); await vi.waitFor(() => expect(once).toHaveBeenCalledWith("allow")); single.unmount();
  });
  it("grants ordinary steps once per task and keeps remote operations and hard denies separate", async () => {
    const steps = ["node one.js", "node two.js", "git push", "rm -rf /"];
    const executed: string[] = []; const registry = new ToolRegistry();
    registry.register({ name: "Bash", description: "fake", category: "command", schema: () => ({ input_schema: { type: "object" } }), execute: async (args) => { executed.push(String(args.command)); return { isError: false, output: "done" }; } });
    const workDir = workspace();
    for (let task = 0; task < 2; task++) {
      let i = 0; const provider: Provider = { config, async *stream() { const command = steps[i++]; if (command) yield { type: "tool_call_complete", toolId: `t${task}-${i}`, toolName: "Bash", arguments: { command } }; yield { type: "done" }; } };
      const conversation = new Conversation(); conversation.addUserMessage("处理任务");
      let approvals = 0; const ask = vi.fn(async () => ++approvals === 1 ? "allowTask" as const : "allow" as const);
      for await (const _ of new Agent({ provider, registry, workDir, conversation, systemPrompt: "offline", checker: new PermissionChecker(workDir), onPermissionRequest: ask }).run()) { /* consume */ }
      expect(ask).toHaveBeenCalledTimes(2);
    }
    expect(executed).toEqual([...steps.slice(0, 3), ...steps.slice(0, 3)]);
  });
  it("keeps plan mode, explicit rules and unknown effects outside task approval", () => {
    for (const [mode, reason] of [["plan", "Mode: plan"], ["default", "Permission rule: ask"], ["default", "上次操作结果未知"]] as const) {
      expect(taskApprovalEligible("Bash", { command: "node task.js" }, mode, { effect: "ask", reason })).toBe(false);
    }
    expect(taskApprovalEligible("EditFile", { file_path: "a.ts" }, "default", { effect: "ask", reason: "Mode: default" })).toBe(true);
    expect(taskApprovalEligible("HookHttp", { url: "http://unused" }, "default", { effect: "ask", reason: "Mode: default" })).toBe(false);
  });
  it("accepts T directly without Enter only when task approval is offered", async () => {
    const complete = vi.fn();
    const view = render(<PermissionDialog toolName="Bash" argsSummary="node task.js" reason="Mode: default" allowTask onComplete={complete} />);
    view.stdin.write("t"); await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("allowTask")); view.unmount();
    const denied = vi.fn();
    const separate = render(<PermissionDialog toolName="Bash" argsSummary="git push" reason="Mode: default" onComplete={denied} />);
    separate.stdin.write("t"); expect(denied).not.toHaveBeenCalled(); separate.stdin.write("y");
    await vi.waitFor(() => expect(denied).toHaveBeenCalledWith("allow")); separate.unmount();
  });
  it("spills a large result early for small windows and retains the full original bytes", () => {
    const workDir = workspace(); const content = "source".repeat(4000);
    const messages: ConversationMessage[] = [{ role: "user", content: [{ type: "tool_result", toolUseId: "large", content, isError: false }] }];
    const bounded = applyBudget(messages, workDir, new ContentReplacementState(), toolOutputBudget(32768, 8192));
    expect(JSON.stringify(bounded)).toContain("persisted-output");
    expect(readFileSync(join(workDir, ".qicode", "tool_results", "large"), "utf8")).toBe(content);
    expect(JSON.stringify(messages)).toContain(content);
    expect(toolOutputBudget(200000, 8192)).toEqual({ singleResultLimit: 50000, aggregateLimit: 200000 });
  });
  it("does not overwrite an existing full spill with its preview during aggregate budgeting", () => {
    const messages: ConversationMessage[] = [{ role: "user", content: ["one", "two"].map((id) => ({ type: "tool_result", toolUseId: id, content: "x".repeat(20000), isError: false })) }];
    const workDir = workspace(); const state = new ContentReplacementState();
    expect(() => applyBudget(messages, workDir, state, { singleResultLimit: 5000, aggregateLimit: 1000 })).not.toThrow();
    expect(readFileSync(join(workDir, ".qicode", "tool_results", "one"), "utf8")).toHaveLength(20000);
  });
  it("does not replace history with a larger summary and stops after three ineffective attempts", async () => {
    let calls = 0; const provider: Provider = { config, async *stream() { calls++; yield { type: "text_delta", text: "x".repeat(100000) }; yield { type: "done" }; } };
    const conversation = new Conversation(); for (let i = 0; i < 12; i++) conversation.addUserMessage("x".repeat(7500));
    const before = conversation.getMessages(); const tracking = new AutoCompactTrackingState();
    for (let attempt = 0; attempt < 3; attempt++) expect((await manageContext(conversation, provider, 32768, 8192, tracking, new RecoveryState(), [])).compacted).toBe(false);
    expect((await manageContext(conversation, provider, 32768, 8192, tracking, new RecoveryState(), [])).blocked).toBe(true);
    expect(calls).toBe(3); expect(conversation.getMessages()).toEqual(before);
  });
});
