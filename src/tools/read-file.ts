import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { intArg, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";
import { ReadFileDescription } from "./descriptions.js";
import { canonicalFilePath, contentHash } from "../fs/file-access.js";

export class ReadFileTool implements Tool {
  readonly name = "ReadFile";
  readonly description = ReadFileDescription;
  readonly category = "read" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "要读取的文件路径" },
          offset: { type: "integer", default: 0, description: "从第几行开始读取，使用从 0 开始的偏移量" },
          limit: { type: "integer", default: 2000, description: "最多读取的行数" },
        },
        required: ["file_path"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    if (!filePath) return { output: "Error: file_path is required", isError: true };

    const offset = Math.max(0, intArg(args, "offset", 0));
    const limit = Math.max(0, intArg(args, "limit", 2000));
    const absolutePath = resolve(ctx.workDir, filePath);

    try {
      if (ctx.abortSignal?.aborted) return { output: "读取已取消", isError: true };
      const info = await stat(absolutePath);
      if (info.isDirectory()) {
        return {
          output: `Error: '${filePath}' is a directory. Use Glob to find files inside it.`,
          isError: true,
        };
      }
      if (info.size > 16 * 1024 * 1024) return { output: "文件超过 16 MiB 读取上限，请先使用 Grep 定位或缩小输入文件。", isError: true };

      const content = await readFile(absolutePath, "utf8");
      ctx.fileVersions?.set(canonicalFilePath(absolutePath), contentHash(content));
      if (ctx.abortSignal?.aborted) return { output: "读取已取消", isError: true };
      const allLines = content.split("\n");
      const lines = allLines.slice(offset, offset + limit);
      const end = Math.min(allLines.length, offset + lines.length);
      const range = offset > 0 || end < allLines.length ? `\n[已显示 ${lines.length ? offset + 1 : 0}-${end}/${allLines.length} 行${end < allLines.length ? `；继续读取请用 offset=${end}` : "；已到文件末尾"}]` : "";
      ctx.readFiles?.add(absolutePath);
      return {
        output: lines
          .map((line, index) => `${offset + index + 1}\t${line.replace(/\r$/, "")}`)
          .join("\n") + range,
        isError: false,
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        return { output: `Error: file not found: ${filePath}`, isError: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Error reading file: ${message}`, isError: true };
    }
  }
}
