import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { decodeChildOutput } from "../tools/bash.js";

const PAGE_BYTES = 8192;
export interface ToolLogPage { text: string; offset: number; total: number }

export async function readToolLogPage(workDir: string, logPath: string, offset: number): Promise<ToolLogPage> {
  const root = join(await realpath(workDir), ".qicode", "tool_results");
  const name = basename(logPath);
  if (!/^command-[\da-f-]{36}\.log$/i.test(name) || await realpath(dirname(resolve(workDir, logPath))) !== root || await realpath(root) !== root) {
    throw new Error("日志不在当前项目工具日志目录内");
  }
  const path = join(root, name);
  if (!(await lstat(path)).isFile()) throw new Error("工具日志不可读取");
  const file = await open(path, "r");
  try {
    const total = (await file.stat()).size;
    const start = Math.min(Math.max(0, offset), Math.max(0, Math.ceil(total / PAGE_BYTES) - 1) * PAGE_BYTES);
    const bytes = Buffer.alloc(PAGE_BYTES + 3);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    let first = 0;
    let end = Math.min(PAGE_BYTES, bytesRead);
    if (start > 0) while (first < 3 && first < end && isUtf8Continuation(bytes[first]!)) first++;
    while (end < bytesRead && isUtf8Continuation(bytes[end]!)) end++;
    let text: string;
    try { text = new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(first, end)); }
    catch { text = decodeChildOutput(bytes.subarray(0, Math.min(PAGE_BYTES, bytesRead))); }
    return { text, offset: start, total };
  } finally { await file.close(); }
}

function isUtf8Continuation(byte: number): boolean { return (byte & 0xc0) === 0x80; }

export const toolLogPageBytes = PAGE_BYTES;
