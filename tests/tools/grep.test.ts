import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrepTool } from "../../src/tools/grep.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "qicode-grep-"));
  tempDirs.push(path);
  return path;
}

describe("GrepTool", () => {
  it("returns file, line number, and matching content", async () => {
    const workDir = await createTempDir();
    await mkdir(join(workDir, "src"));
    await writeFile(join(workDir, "src", "app.ts"), "first\nCreateAgent()\nlast", "utf8");

    const result = await new GrepTool().execute(
      { pattern: "createagent", path: "src", include: "*.ts" },
      { workDir },
    );

    expect(result).toEqual({ output: "src/app.ts:2:CreateAgent()", isError: false });
  });

  it("skips ignored directories and files outside the include pattern", async () => {
    const workDir = await createTempDir();
    await mkdir(join(workDir, "node_modules"));
    await mkdir(join(workDir, "src"));
    await writeFile(join(workDir, "node_modules", "hidden.ts"), "needle", "utf8");
    await writeFile(join(workDir, "src", "ignored.js"), "needle", "utf8");
    await writeFile(join(workDir, "src", "visible.ts"), "needle", "utf8");

    const result = await new GrepTool().execute(
      { pattern: "needle", include: "*.ts" },
      { workDir },
    );

    expect(result.output).toContain("src/visible.ts:1:needle");
    expect(result.output).not.toContain("node_modules");
    expect(result.output).not.toContain("ignored.js");
  });

  it("returns structured regex errors and successful no-match results", async () => {
    const workDir = await createTempDir();
    const tool = new GrepTool();

    const invalid = await tool.execute({ pattern: "[" }, { workDir });
    const empty = await tool.execute({ pattern: "missing" }, { workDir });

    expect(invalid.isError).toBe(true);
    expect(invalid.output).toContain("invalid regular expression");
    expect(empty).toEqual({ output: "No matches found.", isError: false });
  });
});
