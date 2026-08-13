import { appendFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanExpiredSessions,
  COMPACT_BOUNDARY,
  getSessionFilePath,
  listSessions,
  loadSession,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
} from "../src/session/session.js";

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

  it("skips malformed and empty records while listing the first user message", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-session-"));
    saveMessage(workDir, "one", { role: "system", content: "setup", timestamp: "2026-01-01T00:00:00Z" });
    saveMessage(workDir, "one", { role: "user", content: "  resume this task  ", timestamp: "2026-01-01T00:01:00Z" });
    saveMessage(workDir, "one", { role: "assistant", content: "", timestamp: "2026-01-01T00:02:00Z" });
    appendFileSync(getSessionFilePath(workDir, "one"), "{ broken json\n", "utf8");

    expect(loadSession(workDir, "one")).toHaveLength(2);
    expect(listSessions(workDir)[0]).toMatchObject({ firstMessage: "resume this task", messageCount: 2 });
  });

  it("removes sessions older than thirty days", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-session-"));
    saveMessage(workDir, "old", { role: "user", content: "old", timestamp: "2026-01-01T00:00:00Z" });
    saveMessage(workDir, "fresh", { role: "user", content: "fresh", timestamp: "2026-01-01T00:00:00Z" });
    utimesSync(getSessionFilePath(workDir, "old"), new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(getSessionFilePath(workDir, "fresh"), new Date("2026-01-31"), new Date("2026-01-31"));

    expect(cleanExpiredSessions(workDir, new Date("2026-02-01"))).toBe(1);
    expect(loadSession(workDir, "old")).toEqual([]);
    expect(loadSession(workDir, "fresh")).toHaveLength(1);
  });
});
