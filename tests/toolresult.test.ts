import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBudget, buildSpillPreview, SINGLE_RESULT_LIMIT, writeSpill } from "../src/toolresult/budget.js";
import { ContentReplacementState } from "../src/toolresult/state.js";

describe("tool result budget", () => {
  it("persists oversized output without mutating complete history", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-toolresult-"));
    const content = "x".repeat(SINGLE_RESULT_LIMIT + 1);
    const messages = [{ role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "call_1", content, isError: false }] }];

    const budgeted = applyBudget(messages, workDir, new ContentReplacementState());
    const block = budgeted[0]!.content[0]!;

    expect(messages[0]!.content[0]).toMatchObject({ content });
    if (block.type === "tool_result") {
      expect(block.content).toContain("<persisted-output>");
      expect(readFileSync(join(workDir, ".qicode", "tool_results", "call_1"), "utf8")).toBe(content);
    }
  });

  it("reuses the first replacement decision for the same tool use", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-toolresult-"));
    const state = new ContentReplacementState();
    const content = "x".repeat(SINGLE_RESULT_LIMIT + 1);
    const messages = [{ role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "call_2", content, isError: false }] }];

    expect(applyBudget(messages, workDir, state)).toEqual(applyBudget(messages, workDir, state));
  });

  it("rejects a path traversal tool use id", () => {
    expect(() => writeSpill(process.cwd(), "../escape", "text")).toThrow("Invalid toolUseId");
  });

  it("builds deterministic previews", () => {
    expect(buildSpillPreview("hello", "C:/result")).toBe(buildSpillPreview("hello", "C:/result"));
  });
});
