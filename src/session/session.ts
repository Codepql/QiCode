import {
  appendFileSync,
  closeSync,
  type Dirent,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ConversationBlock } from "../conversation/types.js";
import { withFileLocksSync } from "../fs/file-access.js";
import { atomicWriteFile } from "../fs/atomic-write.js";

export const COMPACT_BOUNDARY = "compact_boundary";
export const SESSION_EXPIRY_DAYS = 30;
const SESSION_FILE_EXTENSION = ".jsonl";
const FIRST_MESSAGE_MAX_CHARS = 100;

export interface SessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  type?: string;
  toolUseId?: string;
}

export interface KeptMessage {
  role: "user" | "assistant";
  content: ConversationBlock[];
}

export interface CompactBoundaryPayload {
  summary: string;
  keep: KeptMessage[];
}

export interface RestoredMessage {
  role: "user" | "assistant";
  content: ConversationBlock[];
}

export interface SessionInfo {
  id: string;
  firstMessage: string;
  messageCount: number;
  size: number;
  modTime: Date;
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function sessionsDir(workDir: string): string {
  return join(workDir, ".qicode", "sessions");
}

export function getSessionFilePath(workDir: string, sessionId: string): string {
  validateSessionId(sessionId);
  return join(sessionsDir(workDir), `${sessionId}${SESSION_FILE_EXTENSION}`);
}

export function saveMessage(
  workDir: string,
  sessionId: string,
  message: SessionMessage,
): void {
  const path = getSessionFilePath(workDir, sessionId);
  mkdirSync(sessionsDir(workDir), { recursive: true });
  withFileLocksSync([path], () => {
    let descriptor: number | undefined = openSync(path, "a+", 0o600);
    try {
      const size = fstatSync(descriptor).size;
      const last = Buffer.alloc(1);
      if (size > 0) readSync(descriptor, last, 0, 1, size - 1);
      if (size > 0 && last[0] !== 10) {
        const content = readFileSync(path);
        const boundary = content.lastIndexOf(10) + 1;
        const tail = content.subarray(boundary);
        if (parseSessionMessage(tail.toString("utf8")).length > 0) appendFileSync(descriptor, "\n", "utf8");
        else {
          // Preserve the damaged tail before repairing an interrupted JSONL append.
          writeFileSync(`${path}.corrupt-${randomBytes(8).toString("hex")}`, tail, { flag: "wx", mode: 0o600 });
          closeSync(descriptor);
          descriptor = undefined;
          atomicWriteFile(path, content.subarray(0, boundary));
          descriptor = openSync(path, "a", 0o600);
        }
      }
      appendFileSync(descriptor, `${JSON.stringify(message)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  });
}

export function saveCompactBoundary(
  workDir: string,
  sessionId: string,
  payload: CompactBoundaryPayload,
): void {
  saveMessage(workDir, sessionId, {
    role: "system",
    content: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
    type: COMPACT_BOUNDARY,
  });
}

export function loadSession(workDir: string, sessionId: string): SessionMessage[] {
  const path = getSessionFilePath(workDir, sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap(parseSessionMessage)
    .filter((message) => message.type === COMPACT_BOUNDARY || message.content.trim() !== "");
}

export function listSessions(workDir: string): SessionInfo[] {
  const directory = sessionsDir(workDir);
  if (!existsSync(directory)) return [];

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SESSION_FILE_EXTENSION))
    .flatMap((entry) => {
      const id = entry.name.slice(0, -SESSION_FILE_EXTENSION.length);
      try {
        validateSessionId(id);
        const filePath = getSessionFilePath(workDir, id);
        const stat = statSync(filePath);
        const messages = loadSession(workDir, id);
        return [{
          id,
          firstMessage: findFirstUserMessage(messages),
          messageCount: messages.length,
          size: stat.size,
          modTime: stat.mtime,
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.modTime.getTime() - left.modTime.getTime());
}

export function cleanExpiredSessions(workDir: string, now = new Date()): number {
  const directory = sessionsDir(workDir);
  if (!existsSync(directory)) return 0;

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  const expiryMs = SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SESSION_FILE_EXTENSION)) continue;
    try {
      const filePath = join(directory, entry.name);
      if (now.getTime() - statSync(filePath).mtimeMs > expiryMs) {
        unlinkSync(filePath);
        removed += 1;
      }
    } catch {
      // Expiration is housekeeping: one inaccessible file must not stop the sweep.
    }
  }
  return removed;
}

export function rebuildFromSession(saved: readonly SessionMessage[]): RestoredMessage[] {
  if (hasStructuredMessages(saved)) return replayStructured(saved);
  const boundaryIndex = findLastBoundary(saved);
  if (boundaryIndex === -1) return replayMessages(saved);

  const payload = parseBoundary(saved[boundaryIndex]!.content);
  if (payload === undefined) return replayMessages(saved.slice(boundaryIndex + 1));

  const restored: RestoredMessage[] = [{
    role: "user",
    content: [{ type: "text", text: buildResumeSummary(payload.summary, payload.keep.length) }],
  }, ...payload.keep];
  restored.push(...replayMessages(saved.slice(boundaryIndex + 1)));
  return restored;
}

export function hasStructuredMessages(saved: readonly SessionMessage[]): boolean {
  return saved.some((entry) => {
    if (entry.type !== "messages_v2") return false;
    try { const frame: unknown = JSON.parse(entry.content); return isRecord(frame) && frame.version === 2 && frame.start === 0 && Array.isArray(frame.messages) && frame.messages.every(isKeptMessage); }
    catch { return false; }
  });
}

function replayStructured(saved: readonly SessionMessage[]): RestoredMessage[] {
  const messages: RestoredMessage[] = [];
  const outcomes = new Map<string, { output: string; isError: boolean } | null>();
  let report = "";
  for (const entry of saved) {
    if (entry.type === "messages_v2") {
      try {
        const frame: unknown = JSON.parse(entry.content);
        if (isRecord(frame) && frame.version === 2 && Number.isInteger(frame.start) && Number(frame.start) >= 0 && Number(frame.start) <= messages.length
          && Array.isArray(frame.messages) && frame.messages.every(isKeptMessage)) {
          messages.splice(Number(frame.start), messages.length, ...frame.messages);
        }
      } catch { /* Retain the last valid state. */ }
    } else if (entry.type === COMPACT_BOUNDARY) {
      const boundary = parseBoundary(entry.content);
      if (boundary) messages.splice(0, messages.length, { role: "user", content: [{ type: "text", text: buildResumeSummary(boundary.summary, boundary.keep.length) }] }, ...boundary.keep);
    } else if (entry.type === "tool_intent_v2" || entry.type === "tool_outcome_v2") {
      try {
        const payload: unknown = JSON.parse(entry.content);
        if (isRecord(payload) && typeof payload.id === "string") {
          if (entry.type === "tool_intent_v2") outcomes.set(payload.id, null);
          else if (isRecord(payload.result) && typeof payload.result.output === "string" && typeof payload.result.isError === "boolean") outcomes.set(payload.id, { output: payload.result.output, isError: payload.result.isError });
        }
      } catch { /* Missing or damaged outcome is unknown, never safe to replay. */ }
    } else if (entry.type === "delivery_v2") report = entry.content;
    else if (entry.type === undefined && isRestorableRole(entry.role)) messages.push({ role: entry.role, content: [{ type: "text", text: entry.content }] });
  }
  const pending = new Map<string, string>();
  for (const message of messages) for (const block of message.content) {
    if (block.type === "tool_use") pending.set(block.id, block.name);
    else if (block.type === "tool_result") pending.delete(block.toolUseId);
  }
  if (pending.size) messages.push({ role: "user", content: [...pending].map(([id, name]) => {
    const result = outcomes.get(id);
    return { type: "tool_result" as const, toolUseId: id, isError: result?.isError ?? true,
      ...(result ? {} : { executionState: outcomes.has(id) ? "unknown" as const : "not_executed" as const }),
      content: result?.output ?? (outcomes.has(id) ? `工具 ${name} 曾开始但结果未知；请核对磁盘/进程，禁止自动重放副作用。` : `工具 ${name} 未开始执行；请重新判断下一步。`) };
  }) });
  if (pending.size || report) {
    const reminder: RestoredMessage = { role: "user", content: [{ type: "text", text: `<system-reminder>\n已恢复结构化工作现场。先核对当前磁盘与任务剩余步骤；恢复不意味着旧命令仍在运行。${report ? `\n上次交付记录（历史事实，未证明当前文件仍一致）：${report}` : ""}\n</system-reminder>` }] };
    const prior = messages.findLastIndex((message) => message.role === "user" && message.content.some((block) => block.type === "text" && block.text.startsWith("<system-reminder>\n已恢复结构化工作现场。")));
    if (prior < 0) messages.push(reminder); else messages[prior] = reminder;
  }
  return messages;
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("Session id must contain only letters, numbers, underscores, or hyphens");
  }
}

function parseSessionMessage(line: string): SessionMessage[] {
  try {
    const value: unknown = JSON.parse(line);
    return isSessionMessage(value) ? [value] : [];
  } catch {
    return [];
  }
}

function isSessionMessage(value: unknown): value is SessionMessage {
  if (!isRecord(value)) return false;
  return isRole(value.role)
    && typeof value.content === "string"
    && typeof value.timestamp === "string"
    && (value.type === undefined || typeof value.type === "string")
    && (value.toolUseId === undefined || typeof value.toolUseId === "string");
}

function findLastBoundary(saved: readonly SessionMessage[]): number {
  for (let index = saved.length - 1; index >= 0; index -= 1) {
    if (saved[index]!.type === COMPACT_BOUNDARY) return index;
  }
  return -1;
}

function parseBoundary(content: string): CompactBoundaryPayload | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.keep)) {
      return undefined;
    }
    const keep = value.keep.filter(isKeptMessage);
    return { summary: value.summary, keep };
  } catch {
    return undefined;
  }
}

function replayMessages(saved: readonly SessionMessage[]): RestoredMessage[] {
  return saved.flatMap((message) => (
    isRestorableRole(message.role) && message.content.trim() !== ""
      ? [{ role: message.role, content: [{ type: "text", text: message.content }] }]
      : []
  ));
}

function findFirstUserMessage(messages: readonly SessionMessage[]): string {
  const first = messages.find((message) => (
    message.role === "user" && message.content.trim() !== ""
  ));
  return first === undefined
    ? "(no user message)"
    : first.content.trim().slice(0, FIRST_MESSAGE_MAX_CHARS);
}

function buildResumeSummary(summary: string, keptCount: number): string {
  let content = `This conversation continues after context compaction. Earlier conversation summary:\n\n${summary}`;
  if (keptCount > 0) content += "\n\nRecent messages are preserved verbatim below.";
  return content;
}

function isKeptMessage(value: unknown): value is KeptMessage {
  return isRecord(value)
    && isRestorableRole(value.role)
    && Array.isArray(value.content)
    && value.content.every(isConversationBlock);
}

function isConversationBlock(value: unknown): value is ConversationBlock {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "thinking") {
    return typeof value.thinking === "string"
      && typeof value.signature === "string"
      && value.hidden === true;
  }
  if (value.type === "tool_use") {
    return typeof value.id === "string"
      && typeof value.name === "string"
      && isRecord(value.input);
  }
  return value.type === "tool_result"
    && typeof value.toolUseId === "string"
    && typeof value.content === "string"
    && typeof value.isError === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is SessionMessage["role"] {
  return value === "user" || value === "assistant" || value === "system";
}

function isRestorableRole(value: unknown): value is RestoredMessage["role"] {
  return value === "user" || value === "assistant";
}
