import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditFileTool } from "../../src/tools/edit-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFile(content: string): Promise<{ workDir: string; filePath: string }> {
  const workDir = await mkdtemp(join(tmpdir(), "qicode-edit-"));
  tempDirs.push(workDir);
  const filePath = join(workDir, "demo.txt");
  await writeFile(filePath, content, "utf8");
  return { workDir, filePath };
}

describe("EditFileTool", () => {
  it("replaces one exact match", async () => {
    const { workDir, filePath } = await createFile("hello old world");

    const result = await new EditFileTool().execute(
      { file_path: "demo.txt", old_string: "old", new_string: "new" },
      { workDir },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("文件已编辑：demo.txt");
    expect(result.metadata?.diff).toContain("+hello new world");
    expect(await readFile(filePath, "utf8")).toBe("hello new world");
  });

  it("returns different errors for zero and multiple matches", async () => {
    const { workDir } = await createFile("same and same");
    const tool = new EditFileTool();

    const missing = await tool.execute(
      { file_path: "demo.txt", old_string: "missing", new_string: "new" },
      { workDir },
    );
    const multiple = await tool.execute(
      { file_path: "demo.txt", old_string: "same", new_string: "new" },
      { workDir },
    );

    expect(missing.output).toContain("未找到 old_string");
    expect(multiple.output).toContain("找到 2 处");
    expect(missing.isError).toBe(true);
    expect(multiple.isError).toBe(true);
  });

  it("replaces every match only when replace_all is true", async () => {
    const { workDir, filePath } = await createFile("same and same");

    const result = await new EditFileTool().execute(
      {
        file_path: "demo.txt",
        old_string: "same",
        new_string: "new",
        replace_all: true,
      },
      { workDir },
    );

    expect(result).toMatchObject({
      output: expect.stringContaining("文件已编辑：demo.txt（替换 2 处）"),
      isError: false,
    });
    expect(await readFile(filePath, "utf8")).toBe("new and new");
  });

  it("rejects identical old and new strings", async () => {
    const { workDir } = await createFile("same");

    const result = await new EditFileTool().execute(
      { file_path: "demo.txt", old_string: "same", new_string: "same" },
      { workDir },
    );

    expect(result).toEqual({
      output: "错误：old_string 和 new_string 不能相同",
      isError: true,
    });
  });
});
