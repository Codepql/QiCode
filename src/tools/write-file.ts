import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WriteFileDescription } from "./descriptions.js";
import { strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

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
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      return {
        output: `文件已写入：${filePath}（${content.split("\n").length} 行）`,
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `写入文件失败：${message}`, isError: true };
    }
  }
}
