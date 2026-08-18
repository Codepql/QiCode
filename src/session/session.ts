import {
  appendFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ConversationBlock } from "../conversation/types.js";

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
  appendFileSync(path, `${JSON.stringify(message)}\n`, "utf8");
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
