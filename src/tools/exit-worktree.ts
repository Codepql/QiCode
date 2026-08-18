import type { Tool, ToolContext, ToolResult } from "./types.js";
import { strArg } from "./types.js";
import { hasWorktreeChanges, removeAgentWorktree } from "../worktree/worktree.js";

export class ExitWorktreeTool implements Tool {
  readonly name = "ExitWorktree";
  readonly description = "Leave an isolated Git worktree, cleaning it only when no changes are present.";
  readonly category = "write" as const;
  readonly deferred = true;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path returned by EnterWorktree." },
          branch: { type: "string", description: "Branch returned by EnterWorktree." },
          git_root: { type: "string", description: "Repository root containing the managed worktree." },
          head_commit: { type: "string", description: "Optional commit used as the change baseline." },
        },
        required: ["path", "branch", "git_root"],
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const path = strArg(args, "path").trim();
    const branch = strArg(args, "branch").trim();
    const gitRoot = strArg(args, "git_root").trim();
    const headCommitValue = args["head_commit"];
    if (path === "" || branch === "" || gitRoot === "") {
      return { output: "Error: path, branch, and git_root are required", isError: true };
    }
    if (headCommitValue !== undefined && typeof headCommitValue !== "string") {
      return { output: "Error: head_commit must be a string", isError: true };
    }
    const headCommit = typeof headCommitValue === "string" ? headCommitValue.trim() : "";

    const changed = headCommit === "" ? false : await hasWorktreeChanges(path, headCommit);
    if (changed) {
      return {
        output: `Worktree has changes, kept at: ${path}\nBranch: ${branch}`,
        isError: false,
      };
    }

    try {
      const result = await removeAgentWorktree(path, branch, gitRoot);
      if (result.warnings.length > 0) {
        return {
          output: `Worktree cleanup completed with warnings: ${path}\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`,
          isError: true,
        };
      }
      return { output: `Worktree cleaned up (no changes): ${path}`, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Error cleaning up worktree: ${message}`, isError: true };
    }
  }
}
