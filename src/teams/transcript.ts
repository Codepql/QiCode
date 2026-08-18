import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation } from "../conversation/conversation.js";
import type { ConversationBlock, ConversationMessage } from "../conversation/types.js";

export interface TranscriptEntry {
  role: ConversationMessage["role"];
  content: ConversationBlock[];
}

const SAFE_MEMBER_NAME = /^[A-Za-z0-9_-]+$/;

export function saveTranscript(
  teamDirectory: string,
  memberName: string,
  conversation: Conversation,
): string {
  assertSafeMemberName(memberName);
  const directory = join(teamDirectory, "transcripts");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${memberName}.json`);
  const entries: TranscriptEntry[] = conversation.getMessages().map((message) => ({
    role: message.role,
    content: message.content,
  }));
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf8");
  return path;
}

export function loadTranscript(teamDirectory: string, memberName: string): TranscriptEntry[] | null {
  assertSafeMemberName(memberName);
  const path = join(teamDirectory, "transcripts", `${memberName}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed as TranscriptEntry[] : null;
  } catch {
    return null;
  }
}

function assertSafeMemberName(name: string): void {
  if (!SAFE_MEMBER_NAME.test(name)) {
    throw new Error("member name must contain only alphanumeric characters, hyphen, and underscore");
  }
}
