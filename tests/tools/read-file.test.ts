import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadFileTool } from "../../src/tools/read-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "qicode-read-"));
  tempDirs.push(path);
  return path;
}

describe("ReadFileTool", () => {
  it("reads a relative file with line numbers, offset, and limit", async () => {
    const workDir = await createTempDir();
    await writeFile(join(workDir, "notes.txt"), "first\nsecond\nthird\nfourth", "utf8");

    const result = await new ReadFileTool().execute(
      { file_path: "notes.txt", offset: 1, limit: 2 },
      { workDir },
    );

    expect(result).toEqual({ output: "2\tsecond\n3\tthird", isError: false });
  });

  it("returns structured errors for missing paths and directories", async () => {
    const workDir = await createTempDir();
    await mkdir(join(workDir, "folder"));
    const tool = new ReadFileTool();

    const missing = await tool.execute({ file_path: "missing.txt" }, { workDir });
    const directory = await tool.execute({ file_path: "folder" }, { workDir });

    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("file not found");
    expect(directory.isError).toBe(true);
    expect(directory.output).toContain("directory");
    expect(directory.output).toContain("Glob");
  });

  it("rejects an empty file path", async () => {
    const result = await new ReadFileTool().execute({}, { workDir: process.cwd() });

    expect(result).toEqual({ output: "Error: file_path is required", isError: true });
  });
});
