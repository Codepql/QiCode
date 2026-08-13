import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationBlock } from "../conversation/types.js";

export const COMPACT_BOUNDARY = "compact_boundary";

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

export function getSessionFilePath(workDir: string, sessionId: string): string {
  validateSessionId(sessionId);
  return join(workDir, ".qicode", "sessions", `${sessionId}.jsonl`);
}

export function saveMessage(
  workDir: string,
  sessionId: string,
  message: SessionMessage,
): void {
  const path = getSessionFilePath(workDir, sessionId);
  mkdirSync(join(workDir, ".qicode", "sessions"), { recursive: true });
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
    .flatMap(parseSessionMessage);
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
