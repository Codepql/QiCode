import { Conversation } from "../conversation/conversation.js";
import type { ConversationBlock, ConversationMessage } from "../conversation/types.js";
import type { Provider } from "../llm/client.js";
import type { CompactBoundaryPayload } from "../session/session.js";
import { RecoveryState } from "./recovery.js";
import { withIdleTimeout } from "../agent/execution.js";

export const MAX_CONSECUTIVE_FAILURES = 3;
export const CHARS_PER_TOKEN = 3.5;
export const KEEP_RECENT_TOKENS = 10_000;
export const MIN_KEEP_MESSAGES = 5;
export const KEEP_MAX_TOKENS = 40_000;
export const MIN_COMPACT_PREFIX = 2;
export const SUMMARY_OUTPUT_RESERVE = 20_000;
export const AUTO_COMPACT_SAFETY_MARGIN = 13_000;
export const MANUAL_COMPACT_SAFETY_MARGIN = 3_000;

export interface CompactResult {
  compacted: boolean;
  blocked?: boolean;
  message: string;
  summary?: string;
  keptMessageCount?: number;
  boundary?: CompactBoundaryPayload;
}

export interface UsageAnchor {
  baselineTokens: number;
  anchorCount: number;
}

export class AutoCompactTrackingState {
  consecutiveFailures = 0;
  lastCompactedTokens: number | undefined;
}

export function computeCompactThreshold(
  contextWindow: number,
  maxOutput: number,
  manual = false,
): number {
  const effectiveWindow = contextWindow - Math.min(maxOutput, SUMMARY_OUTPUT_RESERVE);
  const margin = manual ? MANUAL_COMPACT_SAFETY_MARGIN : Math.min(AUTO_COMPACT_SAFETY_MARGIN, Math.floor(contextWindow * 0.15));
  return effectiveWindow - margin;
}

export function estimateMessages(messages: readonly ConversationMessage[]): number {
  const chars = messages.reduce((sum, message) => sum + message.content.reduce(
    (contentSum, block) => contentSum + blockChars(block),
    0,
  ), 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokens(conversation: Conversation): number {
  return estimateMessages(conversation.getMessages());
}

export function currentContextTokens(
  conversation: Conversation,
  anchor: UsageAnchor | null,
): number {
  if (anchor === null) return estimateTokens(conversation);
  const messages = conversation.getMessages();
  return anchor.baselineTokens + estimateMessages(messages.slice(anchor.anchorCount));
}

export function computeKeepStartIndex(messages: readonly ConversationMessage[], tokenBudget = KEEP_MAX_TOKENS): number {
  let tokens = 0;
  let count = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const messageTokens = estimateMessages([message]);
    if (count > 0 && tokens + messageTokens > Math.min(KEEP_MAX_TOKENS, tokenBudget)) break;
    start = index;
    tokens += messageTokens;
    count += 1;
    if (tokens >= Math.min(KEEP_RECENT_TOKENS, tokenBudget) || count >= MIN_KEEP_MESSAGES) break;
  }
  return backUpPastToolUse(messages, start);
}

export async function doCompact(
  conversation: Conversation,
  provider: Provider,
  recoveryState: RecoveryState,
  toolSchemaNames: readonly string[],
  signal?: AbortSignal,
  sourceMessages?: readonly ConversationMessage[],
  targetTokens = 18_000,
): Promise<CompactResult> {
  const messages = sourceMessages ?? conversation.getMessages();
  const keepStart = computeKeepStartIndex(messages, Math.max(512, Math.floor(targetTokens * 0.5)));
  if (keepStart < MIN_COMPACT_PREFIX) {
    return {
      compacted: false,
      message: `Compaction skipped: only ${keepStart} message(s) can be summarized safely.`,
    };
  }

  const toSummarize = messages.slice(0, keepStart);
  const toKeep = messages.slice(keepStart);
  const summary = await requestSummary(provider, toSummarize, signal);
  const recovery = recoveryState.buildRecoveryAttachment(toolSchemaNames, Math.min(4_000, Math.max(0, Math.floor(targetTokens * 0.2))));
  const summaryContent = buildSummaryContent(summary, toKeep.length, recovery);
  const candidate = new Conversation(); candidate.replaceWithCompacted(summaryContent, toKeep);
  if (estimateTokens(candidate) >= estimateMessages(messages)) return { compacted: false, message: "压缩未减少上下文，保留原对话；请缩小读取范围或核对模型容量配置。" };
  conversation.replaceWithCompacted(summaryContent, toKeep);

  return {
    compacted: true,
    message: `Compacted ${toSummarize.length} messages into a ${summary.length}-character summary; kept ${toKeep.length} recent messages.`,
    summary,
    keptMessageCount: toKeep.length,
    boundary: {
      summary,
      keep: toKeep.map((message) => ({
        role: message.role,
        content: structuredClone(message.content),
      })),
    },
  };
}

export async function manageContext(
  conversation: Conversation,
  provider: Provider,
  contextWindow: number,
  maxOutput: number,
  tracking: AutoCompactTrackingState,
  recoveryState: RecoveryState,
  toolSchemaNames: readonly string[],
  anchor: UsageAnchor | null = null,
  signal?: AbortSignal,
  budgetedMessages?: readonly ConversationMessage[],
): Promise<CompactResult> {
  const messages = budgetedMessages ?? conversation.getMessages();
  const tokens = anchor === null ? estimateMessages(messages) : anchor.baselineTokens + estimateMessages(messages.slice(anchor.anchorCount));
  const autoThreshold = computeCompactThreshold(contextWindow, maxOutput);
  if (tokens < autoThreshold) return { compacted: false, message: "" };

  const hardBlock = computeCompactThreshold(contextWindow, maxOutput, true);
  // Do not pay for another summary with almost no new context; never suppress hard-limit recovery.
  if (tracking.lastCompactedTokens !== undefined && tokens < hardBlock
    && tokens < tracking.lastCompactedTokens + Math.max(1024, Math.floor(contextWindow * 0.05))) return { compacted: false, message: "" };
  if (tracking.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      compacted: false,
      blocked: tokens >= hardBlock,
      message: `连续 ${MAX_CONSECUTIVE_FAILURES} 次压缩失败或无效；${tokens >= hardBlock ? "已停止本次任务，保留原对话。请缩小任务或核对模型容量配置。" : "暂缓重复压缩，保留原对话。"}`,
    };
  }

  try {
    const result = await doCompact(conversation, provider, recoveryState, toolSchemaNames, signal, messages, Math.max(1024, Math.floor(autoThreshold * 0.7)));
    if (result.compacted) { tracking.consecutiveFailures = 0; tracking.lastCompactedTokens = estimateTokens(conversation); }
    else tracking.consecutiveFailures++;
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    tracking.consecutiveFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    return { compacted: false, message: `Auto-compact failed: ${message}` };
  }
}

export function forceCompact(
  conversation: Conversation,
  provider: Provider,
  recoveryState: RecoveryState,
  toolSchemaNames: readonly string[],
  signal?: AbortSignal,
): Promise<CompactResult> {
  return doCompact(conversation, provider, recoveryState, toolSchemaNames, signal);
}

function backUpPastToolUse(messages: readonly ConversationMessage[], start: number): number {
  if (start <= 0 || start >= messages.length) return start;
  const resultIds = messages[start]!.content
    .filter((block) => block.type === "tool_result")
    .map((block) => block.toolUseId);
  if (resultIds.length === 0) return start;

  const ids = new Set(resultIds);
  for (let index = start - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.content.some(
      (block) => block.type === "tool_use" && ids.has(block.id),
    )) return index;
  }
  return start;
}

function blockChars(block: ConversationBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length;
    case "tool_use":
      return JSON.stringify({ name: block.name, input: block.input }).length;
    case "tool_result":
      return block.content.length;
  }
}

async function requestSummary(
  provider: Provider,
  messages: readonly ConversationMessage[],
  external?: AbortSignal,
): Promise<string> {
  let response = "";
  const controller = new AbortController();
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  for await (const event of withIdleTimeout(provider.stream({
    signal,
    maxOutputTokens: 1024,
    systemPrompt: "You summarize prior conversation for a coding agent. Do not call tools.",
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: `Summarize this earlier conversation for the next agent turn in at most 600 words. Preserve the task goal, completed work, important decisions, changed files, unresolved issues, and next steps. Return only the summary; do not expand source files into a report.\n\n${serializeMessages(messages)}`,
      }],
    }],
  }), 120_000, controller, signal)) {
    if (event.type === "text_delta") response += event.text;
  }
  const summary = response.trim();
  if (summary === "") throw new Error("Provider returned an empty compaction summary");
  return summary;
}

function serializeMessages(messages: readonly ConversationMessage[]): string {
  return messages.map((message) => {
    const blocks = message.content.map(serializeBlock).join("\n");
    return `[${message.role}]\n${blocks}`;
  }).join("\n\n");
}

function serializeBlock(block: ConversationBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return `[thinking]\n${block.thinking}`;
    case "tool_use":
      return `[tool_use ${block.name}]\n${JSON.stringify(block.input)}`;
    case "tool_result":
      return `[tool_result ${block.toolUseId}]\n${block.content}`;
  }
}

function buildSummaryContent(summary: string, keepCount: number, recovery: string): string {
  let content = `This conversation continues after context compaction. Earlier conversation summary:\n\n${summary}`;
  if (keepCount > 0) content += "\n\nRecent messages are preserved verbatim below.";
  if (recovery !== "") content += `\n\n---\n\n${recovery}`;
  return content;
}
