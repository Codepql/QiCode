import { describe, expect, it, vi } from "vitest";
import { PermissionChecker } from "../../src/permissions/checker.js";
import type { MCPClient } from "../../src/mcp/client.js";
import { MCPToolWrapper, toMcpToolName } from "../../src/mcp/tool-wrapper.js";

describe("MCPToolWrapper", () => {
  it("sanitizes names, preserves schema, and calls the original remote name", async () => {
    const callTool = vi.fn(async () => "created");
    const wrapper = new MCPToolWrapper(
      { callTool } as unknown as MCPClient,
      "git.hub/team",
      {
        name: "create.issue",
        description: "Create an issue",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    );

    expect(toMcpToolName("git.hub/team", "create.issue")).toBe(
      "mcp__git_hub_team__create_issue",
    );
    expect(wrapper).toMatchObject({
      name: "mcp__git_hub_team__create_issue",
      description: "Create an issue",
      category: "command",
      deferred: true,
    });
    expect(wrapper.schema()).toEqual({
      name: "mcp__git_hub_team__create_issue",
      description: "Create an issue",
      input_schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    });

    await expect(wrapper.execute(
      { title: "Bug" },
      { workDir: process.cwd() },
    )).resolves.toEqual({ output: "created", isError: false });
    expect(callTool).toHaveBeenCalledWith("create.issue", { title: "Bug" });
  });

  it("converts remote call failures into tool errors", async () => {
    const wrapper = new MCPToolWrapper(
      {
        callTool: vi.fn(async () => {
          throw new Error("remote unavailable");
        }),
      } as unknown as MCPClient,
      "server",
      { name: "tool", description: "", inputSchema: {} },
    );

    await expect(wrapper.execute({}, { workDir: process.cwd() })).resolves.toEqual({
      output: "MCP tool error: remote unavailable",
      isError: true,
    });
  });

  it("uses the existing command permission policy without MCP-specific branches", () => {
    const toolName = "mcp__github__create_issue";

    expect(new PermissionChecker(process.cwd(), "default").check(
      toolName,
      "command",
      { title: "Bug" },
    ).effect).toBe("ask");
    expect(new PermissionChecker(process.cwd(), "bypassPermissions").check(
      toolName,
      "command",
      { title: "Bug" },
    ).effect).toBe("allow");
  });
});
