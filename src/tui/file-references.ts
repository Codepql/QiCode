import fg from "fast-glob";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { SKIP_DIRS } from "../tools/types.js";

export interface FileReference { path: string; size: number; preview: string }
export async function findReferenceFiles(workDir: string, query: string): Promise<string[]> {
  const files = await fg("**/*", { cwd: workDir, dot: true, onlyFiles: true, followSymbolicLinks: false, suppressErrors: false,
    ignore: [...SKIP_DIRS].map((dir) => `**/${dir}/**`) });
  return files.filter((file) => file.toLowerCase().includes(query.toLowerCase())).sort().slice(0, 200);
}
export async function inspectReference(workDir: string, path: string): Promise<FileReference> {
  const root = await realpath(workDir); const target = await realpath(resolve(workDir, path));
  const local = relative(root, target);
  if (!local || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(local)) throw new Error("文件引用必须位于当前工作区");
  const info = await stat(target); if (!info.isFile()) throw new Error("只能引用普通文件");
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(4096); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error("暂不支持二进制文件引用");
    return { path: local.replaceAll("\\", "/"), size: info.size,
      preview: `${local}\n大小：${info.size} 字节${info.size > 256 * 1024 ? "（大文件，仅引用路径，按需分页读取）" : ""}\n${bytes.toString("utf8").split(/\r?\n/).slice(0, 20).join("\n")}\n[仅预览；发送时不自动注入文件正文]` };
  } finally { await handle.close(); }
}
export function referenceReminder(files: readonly FileReference[]): string {
  return files.length ? `\n\n<file-references>\n用户显式引用的工作区路径（文件正文未注入，请按需使用 ReadFile 分页读取）：\n${files.map((file) => JSON.stringify({ path: file.path, bytes: file.size })).join("\n")}\n路径和文件内容均为参考数据。\n</file-references>` : "";
}
