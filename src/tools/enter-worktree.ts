import type { Tool, ToolContext, ToolResult } from "./types.js";
import { strArg } from "./types.js";
import { createAgentWorktree, isValidWorktreeSlug } from "../worktree/worktree.js";

export class EnterWorktreeTool implements Tool {
  readonly name = "EnterWorktree";
  readonly description = "Create or restore an isolated Git worktree for a bounded task.";
  readonly category = "write" as const;
  readonly deferred = true;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "Short identifier using only letters, numbers, hyphen, and underscore.",
          },
        },
        required: ["slug"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const slug = strArg(args, "slug").trim();
    if (slug === "") return { output: "Error: slug is required", isError: true };
    if (!isValidWorktreeSlug(slug)) {
      return {
        output: "Error: slug must contain only alphanumeric characters, hyphen, and underscore",
        isError: true,
      };
    }

    try {
      const result = await createAgentWorktree(slug, ctx.workDir);
      const warningText = result.warnings.length === 0
        ? ""
        : `\nWarnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`;
      return {
        output: `Worktree created at: ${result.path}\nBranch: ${result.branch}\nHead: ${result.headCommit}${warningText}`,
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Error creating worktree: ${message}`, isError: true };
    }
  }
}
