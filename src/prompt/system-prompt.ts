import { executingActionsSection, usingToolsSection } from "./sections.js";

export function buildSystemPrompt(workDir: string, date = new Date()): string {
  return [
    "你是 QiCode，一个运行在终端中的 AI 助手。",
    "请清晰、简洁地回答问题。需要读取、搜索、修改文件或执行命令时，应使用可用工具，而不是假装已经完成操作。",
    `当前日期：${date.toISOString().slice(0, 10)}`,
    `当前工作目录：${workDir}`,
    usingToolsSection().content,
    executingActionsSection().content,
  ].join("\n\n");
}
