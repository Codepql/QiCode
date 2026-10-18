import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileHistory } from "../src/filehistory/filehistory.js";
import { canonicalFilePath, contentHash } from "../src/fs/file-access.js";

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

    expect(history.rewind(0)).toEqual([canonicalFilePath(file)]);
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

  it("reloads completed checkpoints after restart", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    const history = new FileHistory(workDir, "restart");
    history.trackEdit(file, contentHash("edited"));
    writeFileSync(file, "edited");
    history.recordWrite(file);
    history.makeSnapshot(4, "edit demo");
    const recovered = new FileHistory(workDir, "restart");
    expect(recovered.getSnapshots()[0]?.messageIndex).toBe(4);
    recovered.rewind(0);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(new FileHistory(workDir, "restart").hasSnapshots()).toBe(false);
  });

  it("recovers an interrupted turn before its final checkpoint", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    const history = new FileHistory(workDir, "interrupted");
    history.beginTurn(7, "interrupted edit");
    history.trackEdit(file, contentHash("edited"));
    writeFileSync(file, "edited");
    const recovered = new FileHistory(workDir, "interrupted");
    expect(recovered.getSnapshots()[0]).toMatchObject({ messageIndex: 7, label: "interrupted edit" });
    recovered.rewind(0);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("restores every later turn when rewinding an earlier checkpoint", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const first = join(workDir, "first.txt");
    const second = join(workDir, "second.txt");
    writeFileSync(first, "original");
    const history = new FileHistory(workDir, "multiple");
    history.trackEdit(first);
    writeFileSync(first, "one");
    history.makeSnapshot(0, "first turn");
    history.trackEdit(first);
    writeFileSync(first, "two");
    history.trackEdit(second);
    writeFileSync(second, "new");
    history.makeSnapshot(3, "second turn");
    history.rewind(0);
    expect(readFileSync(first, "utf8")).toBe("original");
    expect(existsSync(second)).toBe(false);
  });

  it("preflights all files and refuses to erase later user edits", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const first = join(workDir, "first.txt");
    const second = join(workDir, "second.txt");
    const history = new FileHistory(workDir, "conflict");
    for (const file of [first, second]) { writeFileSync(file, "original"); history.trackEdit(file); writeFileSync(file, "agent"); }
    history.makeSnapshot(0, "edit both");
    writeFileSync(second, "user edit");
    expect(() => history.rewind(0)).toThrow("changed after the agent edit");
    expect(readFileSync(first, "utf8")).toBe("agent");
    expect(readFileSync(second, "utf8")).toBe("user edit");
    expect(history.hasSnapshots()).toBe(true);
  });

  it("preserves files when a backup is damaged", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    const history = new FileHistory(workDir, "damaged");
    history.trackEdit(file);
    writeFileSync(file, "agent");
    const snapshot = history.makeSnapshot(0, "edit");
    writeFileSync(Object.values(snapshot.backups)[0]!.file!, "damaged");
    expect(() => history.rewind(0)).toThrow("backup is damaged");
    expect(readFileSync(file, "utf8")).toBe("agent");
  });

  it("rejects traversal session IDs and corrupt indexes", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    expect(() => new FileHistory(workDir, "../escape")).toThrow();
    const directory = join(workDir, ".QiCode", "file-history", "corrupt");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "index.json"), "{broken");
    expect(() => new FileHistory(workDir, "corrupt")).toThrow();
  });

  it("refuses to rewind across user edits between agent turns", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    const history = new FileHistory(workDir, "intervening");
    history.trackEdit(file);
    writeFileSync(file, "first agent turn");
    history.makeSnapshot(0, "first");
    writeFileSync(file, "user edit between turns");
    history.trackEdit(file);
    writeFileSync(file, "second agent turn");
    history.makeSnapshot(3, "second");
    expect(() => history.rewind(0)).toThrow("intervening edits");
    expect(readFileSync(file, "utf8")).toBe("second agent turn");
    history.rewind(1);
    expect(readFileSync(file, "utf8")).toBe("user edit between turns");
  });

  it("does not absorb an external edit into the same turn's rollback", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    const history = new FileHistory(workDir, "during-turn");
    history.trackEdit(file, contentHash("agent"));
    writeFileSync(file, "agent");
    history.recordWrite(file);
    writeFileSync(file, "user");
    expect(() => history.trackEdit(file, contentHash("next agent edit"))).toThrow("start a new turn");
    expect(readFileSync(file, "utf8")).toBe("user");
  });

  it("preserves an orphaned backup and continues with a new version", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-history-"));
    const file = join(workDir, "demo.txt");
    writeFileSync(file, "original");
    const history = new FileHistory(workDir, "orphan");
    history.trackEdit(file);
    const orphan = Object.values(history.getSnapshots()[0]!.backups)[0]!.file!;
    unlinkSync(join(workDir, ".QiCode", "file-history", "orphan", "index.json"));
    const recovered = new FileHistory(workDir, "orphan");
    recovered.trackEdit(file, contentHash("edited"));
    writeFileSync(file, "edited");
    recovered.recordWrite(file);
    expect(Object.values(recovered.getSnapshots()[0]!.backups)[0]!.version).toBe(2);
    recovered.rewind(0);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(readFileSync(orphan, "utf8")).toBe("original");
  });
});
