import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Conversation } from "../conversation/conversation.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { withFileLocksSync } from "../fs/file-access.js";
import { getSessionFilePath, hasStructuredMessages, listSessions, loadSession, rebuildFromSession, saveMessage, type RestoredMessage, type SessionInfo } from "./session.js";

interface SessionState { title?: string; draft?: string }
export interface SessionCard extends SessionInfo { title: string; summary: string; project: string; warning?: string }
function statePath(workDir: string, id: string): string {
  getSessionFilePath(workDir, id); // Reuse ID validation before constructing a path.
  return join(workDir, ".qicode", "session-meta", `${id}.json`);
}
export function sessionState(workDir: string, id: string): SessionState {
  const path = statePath(workDir, id);
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("会话元数据损坏");
  const record = value as Record<string, unknown>;
  if (record.title !== undefined && typeof record.title !== "string" || record.draft !== undefined && typeof record.draft !== "string") throw new Error("会话元数据损坏");
  return { ...(typeof record.title === "string" ? { title: record.title } : {}), ...(typeof record.draft === "string" ? { draft: record.draft } : {}) };
}
export function updateSessionState(workDir: string, id: string, patch: SessionState): void {
  const path = statePath(workDir, id); mkdirSync(join(workDir, ".qicode", "session-meta"), { recursive: true });
  if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 120 || /[\x00-\x1f\x7f]/.test(patch.title))) throw new Error("标题须为 1–120 字且不含控制字符");
  if (patch.draft !== undefined && Buffer.byteLength(patch.draft) > 1024 * 1024) throw new Error("草稿超过 1 MiB");
  withFileLocksSync([path], () => atomicWriteFile(path, JSON.stringify({ ...sessionState(workDir, id), ...patch }, null, 2) + "\n"));
  if (patch.draft && !existsSync(getSessionFilePath(workDir, id))) saveMessage(workDir, id, { role: "system", type: "messages_v2", content: JSON.stringify({ version: 2, start: 0, messages: [] }), timestamp: new Date().toISOString() });
}
export function inspectSession(workDir: string, id: string) {
  const raw = readFileSync(getSessionFilePath(workDir, id), "utf8");
  let damaged = 0;
  for (const line of raw.split("\n").filter((line) => line.trim())) {
    try { JSON.parse(line); } catch { damaged++; }
  }
  const saved = loadSession(workDir, id); const messages = rebuildFromSession(saved);
  if (!messages.length) {
    const emptyFrame = saved.some((entry) => {
      try { const frame = JSON.parse(entry.content) as Record<string, unknown>; return entry.type === "messages_v2" && frame.version === 2 && frame.start === 0 && Array.isArray(frame.messages) && frame.messages.length === 0; } catch { return false; }
    });
    if (emptyFrame && sessionState(workDir, id).draft) return { messages, structured: true, warning: "仅有未发送草稿，没有已提交对话" };
    throw new Error("会话没有可恢复的消息，可能已经损坏");
  }
  const structured = hasStructuredMessages(saved);
  return { messages, structured, warning: [damaged ? `跳过 ${damaged} 条损坏记录，恢复内容可能不完整` : "", !structured ? "旧会话仅保留文本，缺少完整工具现场" : ""].filter(Boolean).join("；") };
}

/** Refresh known context in place, preserving historical checkpoint indices. */
export function mergeRestoredContext(messages: readonly RestoredMessage[], current: readonly RestoredMessage[]): RestoredMessage[] {
  const result = structuredClone([...messages]);
  const key = (message: RestoredMessage): string | undefined => {
    const text = Conversation.visibleText(message);
    if (message.role !== "user") return;
    if (text.startsWith("<system-reminder>\nUse the following durable context when it applies.")) return "durable";
    const server = /^<system-reminder>\n# MCP Server: ([^\r\n]+)/.exec(text)?.[1];
    return server ? `mcp:${server}` : undefined;
  };
  for (const message of current) {
    const id = key(message); const positions = id ? result.map((entry, index) => key(entry) === id ? index : -1).filter((index) => index >= 0) : [];
    if (positions.length) for (const index of positions) result[index] = structuredClone(message);
    else result.push(structuredClone(message));
  }
  return result;
}
export function sessionCatalog(workDir: string): SessionCard[] {
  return listSessions(workDir).map((info) => {
    try {
      const { messages, warning } = inspectSession(workDir, info.id);
      const visible = messages.map((message) => ({ role: message.role, text: Conversation.visibleText(message) }))
        .filter((message) => message.text.trim() && !message.text.trimStart().startsWith("<system-reminder>"));
      const first = visible.find((message) => message.role === "user")?.text ?? sessionState(workDir, info.id).draft?.slice(0, 80) ?? "未命名会话";
      const title = sessionState(workDir, info.id).title ?? first.slice(0, 80);
      return { ...info, messageCount: messages.length, firstMessage: first, title, summary: visible.slice(-3).map((message) => `${message.role}: ${message.text.slice(0, 800)}`).join("\n"), project: workDir, ...(warning ? { warning } : {}) };
    } catch (error) {
      return { ...info, title: info.id, summary: "无法预览", project: workDir, warning: error instanceof Error ? error.message : "会话损坏" };
    }
  });
}
