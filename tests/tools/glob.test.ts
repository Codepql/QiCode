import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobTool } from "../../src/tools/glob.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "qicode-glob-"));
  tempDirs.push(path);
  return path;
}

describe("GlobTool", () => {
  it("finds files and sorts newer files first", async () => {
    const workDir = await createTempDir();
    await mkdir(join(workDir, "src"));
    const older = join(workDir, "src", "older.ts");
    const newer = join(workDir, "src", "newer.ts");
    await writeFile(older, "older", "utf8");
    await writeFile(newer, "newer", "utf8");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    const result = await new GlobTool().execute(
      { pattern: "**/*.ts", path: "." },
      { workDir },
    );

    expect(result).toEqual({ output: "src/newer.ts\nsrc/older.ts", isError: false });
  });

  it("skips dependency and build directories", async () => {
    const workDir = await createTempDir();
    await mkdir(join(workDir, "node_modules"));
    await mkdir(join(workDir, "src"));
    await writeFile(join(workDir, "node_modules", "hidden.ts"), "hidden", "utf8");
    await writeFile(join(workDir, "src", "visible.ts"), "visible", "utf8");

    const result = await new GlobTool().execute({ pattern: "**/*.ts" }, { workDir });

    expect(result.output).toContain("src/visible.ts");
    expect(result.output).not.toContain("node_modules");
  });

  it("returns a successful empty result when nothing matches", async () => {
    const workDir = await createTempDir();

    const result = await new GlobTool().execute({ pattern: "**/*.tsx" }, { workDir });

    expect(result).toEqual({ output: "No files matched the pattern.", isError: false });
  });
});
