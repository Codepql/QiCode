import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriteFileTool } from "../../src/tools/write-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "qicode-write-"));
  tempDirs.push(path);
  return path;
}

describe("WriteFileTool", () => {
  it("creates parent directories and writes a relative file", async () => {
    const workDir = await createTempDir();

    const result = await new WriteFileTool().execute(
      { file_path: "a/b/demo.txt", content: "第一行\n第二行" },
      { workDir },
    );

    expect(result).toMatchObject({
      output: expect.stringContaining("文件已写入：a/b/demo.txt（2 行）"),
      isError: false,
    });
    expect(await readFile(join(workDir, "a", "b", "demo.txt"), "utf8")).toBe(
      "第一行\n第二行",
    );
  });

  it("overwrites an existing file", async () => {
    const workDir = await createTempDir();
    const tool = new WriteFileTool();

    await tool.execute({ file_path: "demo.txt", content: "旧内容" }, { workDir });
    await tool.execute({ file_path: "demo.txt", content: "新内容" }, { workDir });

    expect(await readFile(join(workDir, "demo.txt"), "utf8")).toBe("新内容");
  });

  it("distinguishes missing content from an empty file", async () => {
    const workDir = await createTempDir();
    const tool = new WriteFileTool();

    const missing = await tool.execute({ file_path: "demo.txt" }, { workDir });
    const empty = await tool.execute({ file_path: "empty.txt", content: "" }, { workDir });

    expect(missing).toEqual({ output: "错误：content 必须是字符串", isError: true });
    expect(empty.isError).toBe(false);
    expect(await readFile(join(workDir, "empty.txt"), "utf8")).toBe("");
  });
});
