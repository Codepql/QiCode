import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileHistory } from "../src/filehistory/filehistory.js";

describe("FileHistory", () => {
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
