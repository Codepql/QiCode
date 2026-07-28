import { readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { GrepDescription } from "./descriptions.js";
import { SKIP_DIRS, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const MAX_RESULTS = 500;

export class GrepTool implements Tool {
  readonly name = "Grep";
  readonly description = GrepDescription;
  readonly category = "read" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "用于搜索文件内容的正则表达式，不区分大小写" },
          path: { type: "string", description: "要搜索的文件或目录，默认为当前工作目录" },
          include: { type: "string", description: "可选的文件名 Glob 过滤条件，例如 *.ts" },
        },
        required: ["pattern"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = strArg(args, "pattern");
    if (!pattern) return { output: "Error: pattern is required", isError: true };

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Error: invalid regular expression: ${message}`, isError: true };
    }

    const searchPath = resolve(ctx.workDir, strArg(args, "path", "."));
    const include = strArg(args, "include");
    const results: string[] = [];

    const searchFile = async (filePath: string): Promise<void> => {
      if (results.length >= MAX_RESULTS) return;
      if (include && !matchesFileGlob(basename(filePath), include)) return;
      try {
        const lines = (await readFile(filePath, "utf8")).split("\n");
        const relativePath = relative(ctx.workDir, filePath).replaceAll("\\", "/");
        for (let index = 0; index < lines.length && results.length < MAX_RESULTS; index += 1) {
          const line = lines[index]?.replace(/\r$/, "") ?? "";
          regex.lastIndex = 0;
          if (regex.test(line)) results.push(`${relativePath}:${index + 1}:${line}`);
        }
      } catch {
        // Ignore binary and unreadable files; a search should continue with the rest.
      }
    };

    const walk = async (directory: string): Promise<void> => {
      if (results.length >= MAX_RESULTS) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(fullPath);
        else if (entry.isFile()) await searchFile(fullPath);
      }
    };

    try {
      const info = await stat(searchPath);
      if (info.isDirectory()) await walk(searchPath);
      else if (info.isFile()) await searchFile(searchPath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { output: `Error: path not found: ${strArg(args, "path", ".")}`, isError: true };
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Error searching files: ${message}`, isError: true };
    }

    if (results.length === 0) return { output: "No matches found.", isError: false };
    const truncated = results.length >= MAX_RESULTS ? `\n(results truncated at ${MAX_RESULTS} matches)` : "";
    return { output: results.join("\n") + truncated, isError: false };
  }
}

function matchesFileGlob(fileName: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`;
  return new RegExp(expression).test(fileName);
}
