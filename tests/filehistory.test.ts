import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileHistory } from "../src/filehistory/filehistory.js";

describe("FileHistory", () => {
  it("does not create a session directory until a real file backup is needed", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const history = new FileHistory(workDir, "session");
    const sessionDir = join(workDir, ".QiCode", "file-history", "session");

    expect(history.hasSnapshots()).toBe(false);
    expect(existsSync(sessionDir)).toBe(false);

    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    history.trackEdit("demo.txt");
    expect(existsSync(sessionDir)).toBe(true);
  });

  it("cleans only empty session history directories", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const root = join(workDir, ".QiCode", "file-history");
    const emptySession = join(root, "empty");
    const nonEmptySession = join(root, "non-empty");
    mkdirSync(emptySession, { recursive: true });
    mkdirSync(nonEmptySession, { recursive: true });
    writeFileSync(join(nonEmptySession, "backup"), "data");

    expect(FileHistory.cleanupEmptySessionDirs(workDir)).toBe(1);
    expect(existsSync(emptySession)).toBe(false);
    expect(existsSync(nonEmptySession)).toBe(true);
  });

  it("restores the state before the first edit in a turn", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    const history = new FileHistory(workDir, "session");

    history.trackEdit("demo.txt");
    writeFileSync(file, "first edit");
    history.trackEdit("demo.txt");
    writeFileSync(file, "second edit");
    history.makeSnapshot(3, "update demo");

    expect(history.rewind(0)).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("deletes files that did not exist before a tracked write", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "new.txt");
    const history = new FileHistory(workDir, "session");
    history.trackEdit("new.txt");
    writeFileSync(file, "new");
    history.makeSnapshot(0, "create file");

    history.rewind(0);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });
});
