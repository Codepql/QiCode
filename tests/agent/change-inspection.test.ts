import { describe, expect, it } from "vitest";
import { isChangeInspection, inspectionReminder } from "../../src/agent/task-intent.js";
import { TaskDelivery } from "../../src/agent/delivery.js";
import { AutoCompactTrackingState, computeCompactThreshold, manageContext } from "../../src/compact/compact.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { RecoveryState } from "../../src/compact/recovery.js";
import { layoutChat } from "../../src/tui/chat-layout.js";
import type { ChatRequest, Provider } from "../../src/llm/client.js";

describe("change inspection latency regressions", () => {
  it("distinguishes inspecting existing changes from asking for further modifications", () => {
    expect(isChangeInspection("查看更改区代码，这个改动有什么提升")).toBe(true);
    expect(isChangeInspection("查看代码更改区")).toBe(true);
    expect(isChangeInspection("查看改动，然后修复错误")).toBe(false);
    expect(isChangeInspection("实现新功能")).toBe(false);
    expect(inspectionReminder("查看更改区代码")).toContain("不主动跑测试");
    expect(inspectionReminder("查看改动并运行测试")).toContain("用户明确要求");
  });
  it("does not require test evidence for explaining a read-only diff", async () => {
    const delivery = new TaskDelivery("查看更改区代码，这个修改有什么提升", ".", false);
    expect(delivery.actionRequested).toBe(false);
    delivery.record("Bash", { command: "git diff --stat" }, { isError: false, output: "changes" });
    expect(await delivery.continuation()).toBeUndefined();
    expect(delivery.report()).toMatchObject({ status: "completed", changedFiles: [], message: "改动查看结束" });
  });
  it("uses findings for reviews and honors explicitly requested verification", () => {
    const review = inspectionReminder("审查这些改动有没有问题，并运行测试");
    expect(review).toContain("代码审查");
    expect(review).toContain("有证据的问题");
    expect(review).toContain("用户明确要求");
    expect(review).not.toContain("3–5 个主要变化");
    expect(inspectionReminder("查看改动有什么提升")).toContain("3–5 个主要变化");
  });
  it("leaves useful headroom in a conservative 32k window", () => {
    expect(computeCompactThreshold(32768, 8192)).toBeGreaterThan(19000);
    expect(computeCompactThreshold(200000, 8192)).toBe(183616);
  });
  const requests: ChatRequest[] = [];
  const provider: Provider = { config: { name: "fake", protocol: "openai", model: "fake", api_key: "unused", base_url: "http://unused", thinking: false }, async *stream(request) { requests.push(request); yield { type: "text_delta", text: "brief summary" }; yield { type: "done" }; } };
  it("estimates the messages actually sent after output spill instead of full disk logs", async () => {
    requests.length = 0;
    const conversation = new Conversation(); for (let i = 0; i < 12; i++) conversation.addUserMessage("x".repeat(12000));
    const budgeted = conversation.getMessages().map((message) => ({ ...message, content: [{ type: "text" as const, text: "<persisted-output> local log path </persisted-output>" }] }));
    const result = await manageContext(conversation, provider, 32768, 8192, new AutoCompactTrackingState(), new RecoveryState(), [], null, undefined, budgeted);
    expect(result.compacted).toBe(false); expect(requests).toHaveLength(0);
  });
  it("does not summarize almost unchanged context again below the hard limit", async () => {
    requests.length = 0; const tracking = new AutoCompactTrackingState(); tracking.lastCompactedTokens = 20000;
    const conversation = new Conversation(); conversation.addUserMessage("x".repeat(20100 * 3.5));
    await manageContext(conversation, provider, 32768, 8192, tracking, new RecoveryState(), []);
    expect(requests).toHaveLength(0);
  });
  it("still compacts at the hard limit and bounds summary generation", async () => {
    requests.length = 0; const tracking = new AutoCompactTrackingState(); tracking.lastCompactedTokens = 24000;
    const conversation = new Conversation(); for (let i = 0; i < 12; i++) conversation.addUserMessage("x".repeat(7500));
    const result = await manageContext(conversation, provider, 32768, 8192, tracking, new RecoveryState(), []);
    expect(result.compacted).toBe(true); expect(requests).toHaveLength(1); expect(requests[0]!.maxOutputTokens).toBe(1024);
  });
  it("renders long table cells as labeled blocks rather than unaligned pipes", () => {
    const text = "## 提升\n\n| 功能 | 价值 |\n| --- | --- |\n| 恢复 | 长任务可继续 |";
    const lines = layoutChat([{ role: "assistant", content: [{ type: "text", text }] }], "", [], 19);
    expect(lines.map((line) => line.text).join("\n")).toContain("功能：恢复\n价值：长任务可继续");
    expect(lines.some((line) => line.kind === "heading" && line.text === "提升")).toBe(true);
  });
});
