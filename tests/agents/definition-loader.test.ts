import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBuiltinAgentDefinitions, isAgentName } from "../../src/agents/definition.js";
import { loadAgentDefinitions, parseAgentDefinitionFile } from "../../src/agents/loader.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent definitions", () => {
  it("returns copies of built-in roles and accepts only safe slug names", () => {
    const first = getBuiltinAgentDefinitions();
    first[0]!.description = "changed";

    expect(getBuiltinAgentDefinitions().find((item) => item.name === "general-purpose")?.description)
      .not.toBe("changed");
    expect(isAgentName("review-auth")).toBe(true);
    expect(isAgentName("Review Auth")).toBe(false);
  });

  it("lets a project definition override user and built-in definitions", async () => {
    const home = await root("qicode-agent-home-");
    const workDir = await root("qicode-agent-work-");
    await writeDefinition(home, "general.md", definition("general-purpose", "user version"));
    await writeDefinition(workDir, "general.md", definition("general-purpose", "project version"));
    await writeDefinition(workDir, "bad.md", ["---", "name: Bad Name", "---", "ignored"].join("\n"));

    const result = loadAgentDefinitions(workDir, home);

    expect(result.definitions.find((item) => item.name === "general-purpose")?.description)
      .toBe("project version");
    expect(result.definitions.map((item) => item.name)).toEqual(["explore", "general-purpose", "plan"]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("rejects unknown and credential-like frontmatter fields", () => {
    const content = ["---", "name: reviewer", "api_key: secret", "---", "review"].join("\n");
    expect(parseAgentDefinitionFile(content)).toBeNull();
  });
});

async function root(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function writeDefinition(rootDir: string, fileName: string, content: string): Promise<void> {
  const directory = join(rootDir, ".QiCode", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), content, "utf8");
}

function definition(name: string, description: string): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "role prompt"].join("\n");
}
