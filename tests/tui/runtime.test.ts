import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../../src/tui/runtime.js";
import { ToolSearchTool } from "../../src/tools/tool-search.js";

describe("createToolRegistry", () => {
  it("registers Worktree tools as deferred until ToolSearch selects them", async () => {
    const registry = createToolRegistry();

    expect(registry.listToolsForModel().map((tool) => tool.name)).not.toContain("EnterWorktree");
    expect(registry.listToolsForModel().map((tool) => tool.name)).not.toContain("ExitWorktree");

    const search = registry.get("ToolSearch") as ToolSearchTool;
    await expect(search.execute({ query: "worktree" }, { workDir: process.cwd() }))
      .resolves.toMatchObject({ isError: false });
    await expect(search.execute({ query: "select:EnterWorktree,ExitWorktree" }, { workDir: process.cwd() }))
      .resolves.toMatchObject({ isError: false });

    expect(registry.listToolsForModel().map((tool) => tool.name)).toContain("EnterWorktree");
    expect(registry.listToolsForModel().map((tool) => tool.name)).toContain("ExitWorktree");
  });
});
