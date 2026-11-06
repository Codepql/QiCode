import { readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, relative, resolve } from "node:path";
import { GrepDescription } from "./descriptions.js";
import { SKIP_DIRS, strArg, intArg, type Tool, type ToolContext, type ToolResult } from "./types.js";
const execFileAsync = promisify(execFile);

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
          context: { type: "integer", minimum: 0, maximum: 20, description: "每个匹配前后的上下文行数" },
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
    if (ctx.abortSignal?.aborted) return { output: "搜索已取消", isError: true };
    const context = Math.min(20, Math.max(0, intArg(args, "context", 0)));
    const arguments_ = ["--line-number", "--with-filename", "--no-heading", "--color", "never", "--ignore-case", "--no-require-git", "--max-count", String(MAX_RESULTS), "--context", String(context)];
    if (include) arguments_.push("--glob", include);
    for (const directory of SKIP_DIRS) arguments_.push("--glob", `!**/${directory}/**`);
    arguments_.push("--", pattern, relative(ctx.workDir, searchPath) || ".");
    try {
      const { stdout } = await execFileAsync("rg", arguments_, { cwd: ctx.workDir, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}), windowsHide: true });
      const lines = stdout.trimEnd().replaceAll("\\", "/").replace(/^\.\//gm, "").split("\n");
      return { output: lines.slice(0, MAX_RESULTS).join("\n") + (lines.length > MAX_RESULTS ? `\n(results truncated at ${MAX_RESULTS} lines)` : ""), isError: false };
    } catch (error) {
      const failure = error as { code?: string | number; stderr?: string; stdout?: string };
      if (failure.code === 1) return { output: "No matches found.", isError: false };
      if (failure.code !== "ENOENT") return { output: `Error searching files: ${ctx.abortSignal?.aborted ? "搜索已取消" : failure.stderr || String(error)}${failure.stdout ? `\nPartial output:\n${failure.stdout.slice(-8000)}` : ""}`, isError: true };
    }
    // Missing rg: git's own file list preserves .gitignore semantics when available.
    let allowed: Set<string> | undefined;
    try {
      const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ctx.workDir, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000, windowsHide: true, ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}) });
      allowed = new Set(stdout.split("\0").map((name) => resolve(ctx.workDir, name)));
    } catch { /* The fallback below is restricted to ordinary local text files. */ }
    const results: string[] = [];
    let skippedLarge = 0;

    const searchFile = async (filePath: string): Promise<void> => {
      if (ctx.abortSignal?.aborted) throw new Error("搜索已取消");
      if (allowed && !allowed.has(filePath)) return;
      if (results.length >= MAX_RESULTS) return;
      if (include && !matchesFileGlob(basename(filePath), include)) return;
      try {
        if ((await stat(filePath)).size > 2 * 1024 * 1024) { skippedLarge++; return; }
        const lines = (await readFile(filePath, "utf8")).split("\n");
        const relativePath = relative(ctx.workDir, filePath).replaceAll("\\", "/");
        for (let index = 0; index < lines.length && results.length < MAX_RESULTS; index += 1) {
          const line = lines[index]?.replace(/\r$/, "") ?? "";
          regex.lastIndex = 0;
          if (regex.test(line)) results.push(`${relativePath}:${index + 1}:${line}`);
        }
      } catch (error) {
        throw new Error(`无法完整搜索 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const walk = async (directory: string): Promise<void> => {
      if (ctx.abortSignal?.aborted) throw new Error("搜索已取消");
      if (results.length >= MAX_RESULTS) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        throw new Error(`无法读取目录：${directory}`);
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

    const limitations = `\n[降级搜索：rg 不可用；${allowed ? "使用 git 忽略规则" : "未取得 git 文件清单，未应用 .gitignore"}；仅搜索不超过 2 MiB 的普通文本文件（跳过 ${skippedLarge} 个大文件）；不包含上下文行。]`;
    if (results.length === 0) return { output: "No matches found." + limitations, isError: false };
    const truncated = results.length >= MAX_RESULTS ? `\n(results truncated at ${MAX_RESULTS} matches)` : "";
    return { output: results.join("\n") + truncated + limitations, isError: false };
  }
}

function matchesFileGlob(fileName: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`;
  return new RegExp(expression).test(fileName);
}
