import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../../src/cli/init.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("initializeProject", () => {
  it("creates safe configuration templates without overwriting a later run", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-init-"));
    directories.push(workDir);

    const created = await initializeProject(workDir);
    const configPath = join(workDir, ".QiCode", "config.example.yaml");
    const mcpPath = join(workDir, ".QiCode", "mcp-config", "config.example.yaml");

    expect(created).toEqual([configPath, mcpPath]);
    expect(existsSync(join(workDir, ".QiCode", "skills"))).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("token: your-api-token");
    await expect(initializeProject(workDir)).resolves.toEqual([]);
  });
});
