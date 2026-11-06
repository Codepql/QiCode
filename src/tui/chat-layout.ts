import { marked, type Token, type Tokens } from "marked";
import { Conversation } from "../conversation/conversation.js";
import type { ConversationMessage, ToolResultBlock } from "../conversation/types.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";
import { wrapRows } from "./text-layout.js";
import { formatArgs } from "./tool-display.js";

export interface ChatLine { id: string; offset: number; text: string; kind: "text" | "user" | "assistant" | "code" | "tool" | "error" | "heading" }
export interface ActiveTool { toolId: string; toolName: string; args: Record<string, unknown>; output?: string; running?: boolean }
interface Chunk { text: string; kind: ChatLine["kind"] }

function inline(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    if (token.type === "br") return "\n";
    if (token.type === "link") return `${inline((token as Tokens.Link).tokens)} (${(token as Tokens.Link).href})`;
    if ("tokens" in token && Array.isArray(token.tokens)) return inline(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : "";
  }).join("");
}

function markdownChunks(tokens: readonly Token[]): Chunk[] {
  return tokens.flatMap((token): Chunk[] => {
    switch (token.type) {
      case "space": return [];
      case "heading": return [{ text: `\n${inline((token as Tokens.Heading).tokens)}`, kind: "heading" }];
      case "paragraph": return [{ text: inline((token as Tokens.Paragraph).tokens), kind: "text" }];
      case "text": return [{ text: "tokens" in token && Array.isArray(token.tokens) ? inline(token.tokens) : (token as Tokens.Text).text, kind: "text" }];
      case "code": return [{ text: (token as Tokens.Code).text, kind: "code" }];
      case "blockquote": return markdownChunks((token as Tokens.Blockquote).tokens).map((chunk) => ({ ...chunk, text: chunk.text.split("\n").map((line) => `│ ${line}`).join("\n") }));
      case "list": {
        const list = token as Tokens.List;
        return list.items.flatMap((item, i) => markdownChunks(item.tokens).map((chunk, j) => ({
          ...chunk,
          text: `${j === 0 ? list.ordered ? `${Number(list.start || 1) + i}. ` : "* " : "  "}${item.task && j === 0 ? `[${item.checked ? "x" : " "}] ` : ""}${chunk.text}`,
        })));
      }
      case "table": {
        const table = token as Tokens.Table;
        const headers = table.header.map((cell) => inline(cell.tokens));
        // Stack cells with labels; long implementation tables remain readable in narrow terminals.
        return table.rows.map((row): Chunk => ({ text: row.map((cell, index) => `${headers[index] || index + 1}：${inline(cell.tokens)}`).join("\n") + "\n", kind: "text" }));
      }
      case "hr": return [{ text: "────", kind: "tool" }];
      case "html": return [{ text: (token as Tokens.HTML).text, kind: "text" }];
      default: return [];
    }
  });
}

// Bound caches by recent message objects; no process-wide transcript retention.
const markdownCache = new WeakMap<ConversationMessage, { text: string; chunks: Chunk[] }>();
const lineCache = new WeakMap<ConversationMessage, { text: string; width: number; index: number; results: string; lines: ChatLine[] }>();
export function layoutChat(messages: readonly ConversationMessage[], streamingText: string, activeTools: readonly ActiveTool[], width: number, toolPreview = true): ChatLine[] {
  const lines: ChatLine[] = [];
  const results = new Map<string, ToolResultBlock>(messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result").map((result) => [result.toolUseId, result]));
  function append(id: string, text: string, kind: ChatLine["kind"]): void {
    for (const row of wrapRows(sanitizeTerminalText(text), width)) lines.push({ id, offset: row.start, text: row.text, kind });
  }
  function chunks(id: string, parts: Chunk[]): void {
    parts.forEach((chunk, i) => append(`${id}:${i}`, chunk.text, chunk.kind));
  }
  messages.forEach((message, index) => {
    const text = Conversation.visibleText(message);
    if (message.role === "user" && text.trimStart().startsWith("<system-reminder>")) return;
    const tools = message.content.filter((block) => block.type === "tool_use");
    if (!text && !tools.length) return;
    const resultKey = tools.map((tool) => {
      const result = results.get(tool.id);
      return `${toolPreview}:${tool.id}:${result?.isError}:${result?.content.slice(0, 500)}`;
    }).join("\n");
    const cachedLines = lineCache.get(message);
    if (cachedLines && cachedLines.text === text && cachedLines.index === index && cachedLines.width === width && cachedLines.results === resultKey) {
      for (const line of cachedLines.lines) lines.push(line);
      return;
    }
    const start = lines.length;
    const id = `message:${index}`;
    append(`${id}:role`, message.role === "user" ? "You" : "QiCode", message.role === "user" ? "user" : "assistant");
    if (text) {
      if (message.role === "user") append(`${id}:text`, text, "text");
      else {
        let cached = markdownCache.get(message);
        if (!cached || cached.text !== text) {
          cached = { text, chunks: markdownChunks(marked.lexer(sanitizeTerminalText(text))) };
          markdownCache.set(message, cached);
        }
        chunks(`${id}:text`, cached.chunks);
      }
    }
    for (const tool of tools) {
      const result = results.get(tool.id);
      append(`tool:${tool.id}`, `${result ? result.isError ? "✗" : "✓" : "●"} ${tool.name} ${formatArgs(tool.input)}`, result?.isError ? "error" : "tool");
      if (toolPreview && result?.content) {
        const preview = result.content.length > 500 ? `${result.content.slice(0, 499)}…` : result.content;
        append(`result:${tool.id}`, preview, "tool");
      }
    }
    append(`${id}:gap`, "", "text");
    lineCache.set(message, { text, width, index, results: resultKey, lines: lines.slice(start) });
  });
  if (streamingText) {
    const id = `message:${messages.length}`;
    append(`${id}:role`, "QiCode", "assistant");
    chunks(`${id}:text`, markdownChunks(marked.lexer(sanitizeTerminalText(streamingText))));
  }
  for (const tool of activeTools) {
    if (!lines.some((line) => line.id === `tool:${tool.toolId}`)) append(`tool:${tool.toolId}`, `${tool.running ? "●" : "○"} ${tool.toolName} ${formatArgs(tool.args)}`, "tool");
    if (tool.output) append(`progress:${tool.toolId}`, tool.output.slice(-2000).split("\n").slice(-6).join("\n"), "tool");
  }
  return lines;
}

export function findAnchor(lines: readonly ChatLine[], anchor: { id: string; offset: number }, fallback: number): number {
  let found = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.id === anchor.id && lines[i]!.offset <= anchor.offset) found = i;
  }
  return found < 0 ? Math.max(0, Math.min(fallback, lines.length - 1)) : found;
}
