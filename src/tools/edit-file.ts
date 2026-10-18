import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EditFileDescription } from "./descriptions.js";
import { boolArg, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { assertFileVersion, canonicalFilePath, contentHash, withFileLock } from "../fs/file-access.js";

export class EditFileTool implements Tool {
  readonly name = "EditFile";
  readonly description = EditFileDescription;
  readonly category = "write" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "要编辑的文件路径" },
          old_string: { type: "string", description: "要替换的精确原文" },
          new_string: { type: "string", description: "替换后的文本" },
          replace_all: { type: "boolean", default: false, description: "是否替换全部匹配" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    if (!filePath) return { output: "错误：file_path 是必填项", isError: true };

    const oldString = args["old_string"];
    const newString = args["new_string"];
    if (typeof oldString !== "string" || oldString.length === 0) {
      return { output: "错误：old_string 必须是非空字符串", isError: true };
    }
    if (typeof newString !== "string") {
      return { output: "错误：new_string 必须是字符串", isError: true };
    }
    if (oldString === newString) {
      return { output: "错误：old_string 和 new_string 不能相同", isError: true };
    }

    const absolutePath = resolve(ctx.workDir, filePath);
    if (ctx.readFiles && !ctx.readFiles.has(absolutePath)) {
      return {
        output: `错误：编辑前必须先使用 ReadFile 读取文件：${filePath}`,
        isError: true,
      };
    }
    try {
      const target = canonicalFilePath(absolutePath);
      return await withFileLock(target, async () => {
      if (ctx.fileVersions !== undefined) {
        if (!ctx.fileVersions.has(target)) {
          return { output: "错误：编辑前必须先使用 ReadFile 读取文件", isError: true };
        }
        assertFileVersion(target, ctx.fileVersions.get(target)!);
      }
      const content = await readFile(target, "utf8");
      const expected = contentHash(content);
      const count = content.split(oldString).length - 1;
      if (count === 0) {
        return { output: "错误：文件中未找到 old_string", isError: true };
      }

      const replaceAll = boolArg(args, "replace_all");
      if (!replaceAll && count > 1) {
        return {
          output: `错误：old_string 在文件中找到 ${count} 处。请提供更多上下文使其唯一，或将 replace_all 设为 true。`,
          isError: true,
        };
      }

      const updated = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);
      if (ctx.abortSignal?.aborted) throw new Error("File operation cancelled");
      assertFileVersion(target, expected);
      ctx.fileHistory?.trackEdit(target, contentHash(updated));
      atomicWriteFile(target, updated, () => assertFileVersion(target, expected));
      ctx.fileVersions?.set(target, contentHash(updated));
      ctx.fileHistory?.recordWrite(target);
      return {
        output: replaceAll && count > 1
          ? `文件已编辑：${filePath}（替换 ${count} 处）`
          : `文件已编辑：${filePath}`,
        isError: false,
      };
      }, ctx.abortSignal);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { output: `错误：文件不存在：${filePath}`, isError: true };
      const message = error instanceof Error ? error.message : String(error);
      return { output: `编辑文件失败：${message}`, isError: true };
    }
  }
}
