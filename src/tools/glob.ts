import fg from "fast-glob";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GlobDescription } from "./descriptions.js";
import { intArg, SKIP_DIRS, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const MAX_MATCHES = 1000;

export class GlobTool implements Tool {
  readonly name = "Glob";
  readonly description = GlobDescription;
  readonly category = "read" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "用于匹配文件路径的 Glob 模式，例如 **/*.ts" },
          path: { type: "string", description: "执行文件搜索的目录，默认为当前工作目录" },
        },
        required: ["pattern"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = strArg(args, "pattern");
    if (!pattern) return { output: "Error: pattern is required", isError: true };

    const basePath = resolve(ctx.workDir, strArg(args, "path", "."));
    try {
      const matches = await fg(pattern, {
        cwd: basePath,
        dot: false,
        onlyFiles: true,
        unique: true,
        ignore: [...SKIP_DIRS].map((dir) => `**/${dir}/**`),
        suppressErrors: true,
      });
      const limited = matches.slice(0, MAX_MATCHES);
      const withMtime = await Promise.all(
        limited.map(async (match) => {
          try {
            const info = await stat(join(basePath, match));
            return { match, mtimeMs: info.mtimeMs };
          } catch {
            return { match, mtimeMs: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs || a.match.localeCompare(b.match));
      return {
        output: withMtime.length === 0
          ? "No files matched the pattern."
          : withMtime.map(({ match }) => match.replaceAll("\\", "/")).join("\n"),
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Error searching files: ${message}`, isError: true };
    }
  }
}
