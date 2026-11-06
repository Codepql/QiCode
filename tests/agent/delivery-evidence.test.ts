import { describe, expect, it } from "vitest";
import { TaskDelivery } from "../../src/agent/delivery.js";
import { rebuildFromSession, type SessionMessage } from "../../src/session/session.js";

describe("delivery evidence and interrupted journals", () => {
  it("never treats final wording as proof of a verified edit", () => {
    const delivery = new TaskDelivery("修复代码", ".", false);
    expect(delivery.report().status).toBe("blocked");
    delivery.record("EditFile", { file_path: "a.ts" }, { output: "done", isError: false });
    expect(delivery.report().status).toBe("unverified");
    delivery.record("Bash", { command: "test", purpose: "verification" }, { output: "passed", isError: false, metadata: { exitCode: 0 } });
    expect(delivery.report().status).toBe("completed");
    delivery.record("EditFile", { file_path: "a.ts" }, { output: "done", isError: false });
    expect(delivery.report().status).toBe("unverified");
    delivery.record("Bash", { command: "test", purpose: "verification" }, { output: "all passed", isError: true, metadata: { exitCode: 1 } });
    expect(delivery.report().status).toBe("failed");
    expect(delivery.repairRounds).toBe(1);
  });

  const entry = (type: string, data: unknown): SessionMessage => ({ role: "system", type, content: JSON.stringify(data), timestamp: new Date().toISOString() });
  const proposal = entry("messages_v2", { version: 2, start: 0, messages: [
    { role: "user", content: [{ type: "text", text: "修改文件" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "write", name: "WriteFile", input: { file_path: "a.ts", content: "x" } }] },
  ] });

  it("distinguishes never-started operations from unknown effects after a crash", () => {
    const neverStarted = rebuildFromSession([proposal]).flatMap((message) => message.content).find((block) => block.type === "tool_result");
    expect(neverStarted).toMatchObject({ executionState: "not_executed", isError: true });
    const interrupted = rebuildFromSession([proposal, entry("tool_intent_v2", { id: "write", name: "WriteFile", args: {} })]);
    const result = interrupted.flatMap((message) => message.content).find((block) => block.type === "tool_result");
    expect(result).toMatchObject({ executionState: "unknown", isError: true });
    expect(result?.type === "tool_result" && result.content).toContain("禁止自动重放");
  });

  it("recovers a durable outcome even when the stable conversation frame was not written", () => {
    const restored = rebuildFromSession([proposal,
      entry("tool_intent_v2", { id: "write", name: "WriteFile", args: {} }),
      entry("tool_outcome_v2", { id: "write", name: "WriteFile", result: { output: "written", isError: false } }),
    ]);
    expect(restored.flatMap((message) => message.content).find((block) => block.type === "tool_result"))
      .toMatchObject({ toolUseId: "write", content: "written", isError: false });
  });
});
