import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ConversationBlock, ConversationMessage, ToolResultBlock } from "../conversation/types.js";
import { ContentReplacementState } from "./state.js";

export const SINGLE_RESULT_LIMIT = 50_000;
export const MESSAGE_AGGREGATE_LIMIT = 200_000;
export const OLD_RESULT_SNIP_CHARS = 2_000;
export const KEEP_RECENT_TURNS = 10;
export const PREVIEW_CHARS = 2_000;

export function applyBudget(
  messages: readonly ConversationMessage[],
  workDir: string,
  state: ContentReplacementState,
): ConversationMessage[] {
  const result = messages.map((message) => budgetMessage(message, workDir, state));
  return snipStale(result);
}

function budgetMessage(
  message: ConversationMessage,
  workDir: string,
  state: ContentReplacementState,
): ConversationMessage {
  const blocks = message.content.map((block) => {
    if (block.type !== "tool_result") return cloneBlock(block);
    const existing = state.getReplacement(block.toolUseId);
    if (existing !== undefined) return { ...block, content: existing };
    if (block.content.length <= SINGLE_RESULT_LIMIT) {
      state.record(block.toolUseId, block.content, block.content);
      return { ...block };
    }
    const path = writeSpill(workDir, block.toolUseId, block.content);
    const preview = buildSpillPreview(block.content, path);
    state.record(block.toolUseId, block.content, preview);
    return { ...block, content: preview };
  });

  const results = blocks.filter(isToolResult);
  if (results.length > 1) applyAggregateBudget(results, workDir, state);
  return { role: message.role, content: blocks };
}

function applyAggregateBudget(
  results: ToolResultBlock[],
  workDir: string,
  state: ContentReplacementState,
): void {
  let total = results.reduce((sum, result) => sum + result.content.length, 0);
  if (total <= MESSAGE_AGGREGATE_LIMIT) return;

  for (const result of [...results].sort((a, b) => b.content.length - a.content.length)) {
    if (total <= MESSAGE_AGGREGATE_LIMIT || result.content.length <= OLD_RESULT_SNIP_CHARS) break;
    const original = result.content;
    const path = writeSpill(workDir, result.toolUseId, original);
    const replacement = buildSpillPreview(original, path);
    result.content = replacement;
    state.record(result.toolUseId, original, replacement);
    total += replacement.length - original.length;
  }
}

export function writeSpill(workDir: string, toolUseId: string, content: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(toolUseId)) {
    throw new Error("Invalid toolUseId for persisted output");
  }
  const directory = join(workDir, ".qicode", "tool_results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, toolUseId);
  const rel = relative(directory, path);
  if (isAbsolute(rel) || rel.startsWith(`..${requireSeparator()}`) || rel === "..") {
    throw new Error("Persisted output path escapes the tool result directory");
  }
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === content) return path;
    throw new Error(`Persisted output conflicts with existing content: ${path}`);
  }
  writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  return path;
}

export function buildSpillPreview(content: string, spillPath: string): string {
  const sizeKB = Math.floor(content.length / 1024);
  const preview = content.slice(0, PREVIEW_CHARS);
  return `<persisted-output>\nOutput too large (${sizeKB}KB). Full content saved to:\n${spillPath}\n\nPreview (first 2KB):\n${preview}${content.length > PREVIEW_CHARS ? "\n..." : ""}\n</persisted-output>`;
}

export function snipStale(messages: ConversationMessage[]): ConversationMessage[] {
  const turnCount = messages.filter((message) => message.role === "assistant").length;
  if (turnCount <= KEEP_RECENT_TURNS) return messages;
  const oldBoundary = turnCount - KEEP_RECENT_TURNS;
  let seen = 0;
  return messages.map((message) => {
    if (message.role === "assistant") seen += 1;
    if (seen > oldBoundary || message.role !== "user") return message;
    return {
      role: message.role,
      content: message.content.map((block) => {
        if (block.type !== "tool_result" || block.content.length <= OLD_RESULT_SNIP_CHARS || block.content.startsWith("<persisted-output>")) return block;
        return { ...block, content: `[Stale output snipped: ${block.content.length} chars]` };
      }),
    };
  });
}

function isToolResult(block: ConversationBlock): block is ToolResultBlock {
  return block.type === "tool_result";
}

function cloneBlock(block: ConversationBlock): ConversationBlock {
  return block.type === "tool_use" ? { ...block, input: structuredClone(block.input) } : { ...block };
}

function requireSeparator(): string {
  return "\\";
}
