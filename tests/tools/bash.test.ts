import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BashTool, interpretExitCode } from "../../src/tools/bash.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "qicode-bash-"));
  tempDirs.push(path);
  return path;
}

describe("interpretExitCode", () => {
  it("treats search and diff exit code 1 as a non-error result", () => {
    expect(interpretExitCode("rg missing .", 1)).toBe(false);
    expect(interpretExitCode("git diff --exit-code", 1)).toBe(false);
    expect(interpretExitCode("node script.js", 1)).toBe(true);
  });
});

describe("BashTool", () => {
  it("returns stdout, stderr, and the exit code", async () => {
    const workDir = await createTempDir();
    const command = `node -e "console.log('hello'); console.error('warning')"`;

    const result = await new BashTool().execute({ command }, { workDir });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("hello");
    expect(result.output).toContain("warning");
    expect(result.output).toContain("退出码：0");
  });

  it("marks ordinary non-zero exits as errors", async () => {
    const workDir = await createTempDir();
    const command = `node -e "process.exit(2)"`;

    const result = await new BashTool().execute({ command }, { workDir });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("退出码：2");
  });

  it("terminates commands that exceed the timeout", async () => {
    const command = `node -e "setTimeout(() => {}, 5000)"`;

    const result = await new BashTool().execute(
      { command, timeout: 1 },
      { workDir: process.cwd() },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("错误：命令执行超过 1 秒");
    expect(result.metadata?.status).toBe("timeout");
  }, 5000);

  it("returns an error when command is missing", async () => {
    const result = await new BashTool().execute({}, { workDir: process.cwd() });

    expect(result).toEqual({ output: "错误：command 是必填项", isError: true });
  });
});
