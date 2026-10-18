import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadFileTool } from "../../src/tools/read-file.js";
import { WriteFileTool } from "../../src/tools/write-file.js";
import { EditFileTool } from "../../src/tools/edit-file.js";
import type { ToolResult } from "../../src/tools/types.js";
import { withFileLock, withFileLocksSync } from "../../src/fs/file-access.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const workDir = await mkdtemp(join(tmpdir(), "qicode-concurrency-"));
  directories.push(workDir);
  await writeFile(join(workDir, "shared.txt"), "original old");
  return workDir;
}

describe("protected file operations", () => {
  it("rejects stale edits even when the old string still matches", async () => {
    const workDir = await fixture();
    const context = { workDir, fileVersions: new Map<string, string | null>() };
    await new ReadFileTool().execute({ file_path: "shared.txt" }, context);
    await writeFile(join(workDir, "shared.txt"), "user changes; original old");
    const result = await new EditFileTool().execute({ file_path: "shared.txt", old_string: "old", new_string: "new" }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("changed since it was read");
    expect(await readFile(join(workDir, "shared.txt"), "utf8")).toBe("user changes; original old");
  });

  it("allows exactly one concurrent writer with the same observed version", async () => {
    const workDir = await fixture();
    const contexts = [0, 1].map(() => ({ workDir, fileVersions: new Map<string, string | null>() }));
    await Promise.all(contexts.map((context) => new ReadFileTool().execute({ file_path: "shared.txt" }, context)));
    const results = await Promise.all(contexts.map((context, index) => new WriteFileTool().execute({
      file_path: "shared.txt", content: `writer-${index}`,
    }, context)));
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
  });

  it("requires an observed version before overwriting an existing file", async () => {
    const workDir = await fixture();
    const result = await new WriteFileTool().execute({ file_path: "shared.txt", content: "blind overwrite" }, {
      workDir, fileVersions: new Map(),
    });
    expect(result.isError).toBe(true);
    expect(await readFile(join(workDir, "shared.txt"), "utf8")).toBe("original old");
  });

  it("leaves the source untouched if the pre-edit backup cannot be persisted", async () => {
    const workDir = await fixture();
    const result = await new WriteFileTool().execute({ file_path: "shared.txt", content: "edited" }, {
      workDir, fileHistory: { trackEdit() { throw new Error("disk full"); }, recordWrite() {} },
    });
    expect(result.isError).toBe(true);
    expect(await readFile(join(workDir, "shared.txt"), "utf8")).toBe("original old");
  });

  it("does not execute a cancelled write or let rewind steal an active write lock", async () => {
    const workDir = await fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await new WriteFileTool().execute({ file_path: "shared.txt", content: "edited" }, { workDir, abortSignal: controller.signal });
    expect(result.isError).toBe(true);
    await withFileLock(join(workDir, "shared.txt"), async () => {
      expect(() => withFileLocksSync([join(workDir, "shared.txt")], () => {})).toThrow("busy");
    });
    expect(await readFile(join(workDir, "shared.txt"), "utf8")).toBe("original old");
  });

  it("serializes writers in independent Node processes", async () => {
    const workDir = await fixture();
    const writers = ["process-a", "process-b"].map((content) => {
      const child = fork(new URL("../fixtures/file-writer.ts", import.meta.url), [workDir, content], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      return child;
    });
    await Promise.all(writers.map((child) => message(child)));
    const pending = writers.map((child) => message(child));
    for (const child of writers) child.send("write");
    const results = await Promise.all(pending) as ToolResult[];
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    expect(["process-a", "process-b"]).toContain(await readFile(join(workDir, "shared.txt"), "utf8"));
  }, 15_000);

  it("recovers a dead process lock before a synchronous restore", async () => {
    const workDir = await fixture();
    const path = join(workDir, "shared.txt");
    const child = fork(new URL("../fixtures/file-lock-owner.ts", import.meta.url), [path], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    expect(await message(child)).toBe("locked");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.send("crash");
    await exited;
    expect(withFileLocksSync([path], () => "recovered")).toBe("recovered");
  }, 15_000);
});

function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const done = (value: unknown) => { cleanup(); resolve(value); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null) => failed(new Error(`Writer exited before replying (${code})`));
    const cleanup = () => { child.off("message", done); child.off("error", failed); child.off("exit", exited); };
    child.once("message", done);
    child.once("error", failed);
    child.once("exit", exited);
  });
}
