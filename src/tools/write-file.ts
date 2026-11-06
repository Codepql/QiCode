import { mkdir, readFile } from "node:fs/promises";
import { changeSummary } from "./edit-diff.js";
import { dirname, resolve } from "node:path";
import { WriteFileDescription } from "./descriptions.js";
import { strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { assertFileVersion, canonicalFilePath, contentHash, fileHash, withFileLock } from "../fs/file-access.js";

export class WriteFileTool implements Tool {
  readonly name = "WriteFile";
  readonly description = WriteFileDescription;
  readonly category = "write" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "要写入的文件路径" },
          content: { type: "string", description: "要写入的完整文本内容" },
        },
        required: ["file_path", "content"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    if (!filePath) return { output: "错误：file_path 是必填项", isError: true };

    const content = args["content"];
    if (typeof content !== "string") {
      return { output: "错误：content 必须是字符串", isError: true };
    }

    const absolutePath = resolve(ctx.workDir, filePath);
    try {
      const target = canonicalFilePath(absolutePath);
      return await withFileLock(target, async () => {
      const expected = fileHash(target);
      if (ctx.fileVersions !== undefined && expected !== null && !ctx.fileVersions.has(target)) {
        return { output: "错误：覆盖前必须先使用 ReadFile 读取文件", isError: true };
      }
      if (ctx.fileVersions?.has(target)) assertFileVersion(target, ctx.fileVersions.get(target)!);
      const before = expected === null ? "" : await readFile(target, "utf8");
      const diff = changeSummary(before, content);
      await mkdir(dirname(target), { recursive: true });
      if (ctx.abortSignal?.aborted) throw new Error("File operation cancelled");
      assertFileVersion(target, expected);
      ctx.fileHistory?.trackEdit(target, contentHash(content));
      atomicWriteFile(target, content, () => assertFileVersion(target, expected));
      ctx.fileVersions?.set(target, contentHash(content));
      ctx.fileHistory?.recordWrite(target);
      return {
        output: `文件已写入：${filePath}（${content.split("\n").length} 行）\n${diff.diff}`,
        isError: false,
        metadata: { filePath: absolutePath, ...diff, status: "completed" },
      };
      }, ctx.abortSignal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `写入文件失败：${message}`, isError: true };
    }
  }
}
