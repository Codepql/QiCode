import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPACT_BOUNDARY, loadSession, rebuildFromSession, saveCompactBoundary, saveMessage } from "../src/session/session.js";

describe("session compaction boundary", () => {
  it("restores the last boundary and later messages", () => {
    const restored = rebuildFromSession([
      { role: "user", content: "old", timestamp: "2026-01-01T00:00:00Z" },
      { role: "system", type: COMPACT_BOUNDARY, timestamp: "2026-01-01T00:01:00Z", content: JSON.stringify({ summary: "old summary", keep: [{ role: "assistant", content: [{ type: "tool_use", id: "read", name: "ReadFile", input: { file_path: "a.ts" } }] }] }) },
      { role: "user", content: "after", timestamp: "2026-01-01T00:02:00Z" },
    ]);

    expect(restored).toEqual([
      { role: "user", content: [{ type: "text", text: expect.stringContaining("old summary") }] },
      { role: "assistant", content: [{ type: "tool_use", id: "read", name: "ReadFile", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "text", text: "after" }] },
    ]);
  });

  it("writes and loads JSONL session records", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-session-"));
    saveMessage(workDir, "one", { role: "user", content: "task", timestamp: "2026-01-01T00:00:00Z" });
    saveCompactBoundary(workDir, "one", { summary: "summary", keep: [] });
    expect(loadSession(workDir, "one")).toHaveLength(2);
  });
});
