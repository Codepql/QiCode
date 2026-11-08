import { marked, type Token, type Tokens } from "marked";
import { Conversation } from "../conversation/conversation.js";
import type { ConversationMessage, ToolResultBlock } from "../conversation/types.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";
import { cellWidth, truncateCells, wrapRows } from "./text-layout.js";
import { formatArgs } from "./tool-display.js";

export interface InlineStyle { bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; link?: boolean }
export interface InlineSpan extends InlineStyle { start: number; end: number }
export interface ChatLine { id: string; offset: number; text: string; kind: "text" | "user" | "assistant" | "code" | "tool" | "error" | "heading"; spans?: InlineSpan[] }
export interface ActiveTool { toolId: string; toolName: string; args: Record<string, unknown>; output?: string; running?: boolean }
interface Chunk { text: string; kind: ChatLine["kind"]; spans?: InlineSpan[] }

function richInline(tokens: readonly Token[], style: InlineStyle = {}): { text: string; spans: InlineSpan[] } {
  let text = ""; const spans: InlineSpan[] = [];
  for (const token of tokens) {
    const next = { ...style, ...(token.type === "strong" ? { bold: true } : token.type === "em" ? { italic: true } : token.type === "del" ? { strike: true } : token.type === "codespan" ? { code: true } : token.type === "link" ? { link: true } : {}) };
    const start = text.length;
    if ("tokens" in token && Array.isArray(token.tokens)) {
      const child = richInline(token.tokens, next); text += child.text;
      spans.push(...child.spans.map((span) => ({ ...span, start: span.start + start, end: span.end + start })));
    } else {
      text += token.type === "br" ? "\n" : "text" in token && typeof token.text === "string" ? token.text : "";
      if (Object.keys(next).length && text.length > start) spans.push({ ...next, start, end: text.length });
    }
    if (token.type === "link") { const link = token as Tokens.Link; if (link.href !== text.slice(start)) text += ` (${link.href})`; }
  }
  return { text, spans };
}

function inline(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    if (token.type === "br") return "\n";
    if (token.type === "link") return `${inline((token as Tokens.Link).tokens)} (${(token as Tokens.Link).href})`;
    if ("tokens" in token && Array.isArray(token.tokens)) return inline(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : "";
  }).join("");
}

function markdownChunks(tokens: readonly Token[], width: number): Chunk[] {
  return tokens.flatMap((token): Chunk[] => {
    switch (token.type) {
      case "space": return [];
      case "heading": return [{ text: "", kind: "text" }, { ...richInline((token as Tokens.Heading).tokens), kind: "heading" }];
      case "paragraph": { const rich = richInline((token as Tokens.Paragraph).tokens); return [{ ...rich, text: rich.text + "\n", kind: "text" }]; }
      case "text": return [{ ...("tokens" in token && Array.isArray(token.tokens) ? richInline(token.tokens) : { text: (token as Tokens.Text).text }), kind: "text" }];
      case "code": {
        const code = token as Tokens.Code;
        return [{ text: `╭─ ${code.lang?.split(/\s/)[0] || "code"}`, kind: "tool" }, ...code.text.split("\n").map((line): Chunk => ({ text: `│ ${line}`, kind: "code" })), { text: "╰─\n", kind: "tool" }];
      }
      case "blockquote": return markdownChunks((token as Tokens.Blockquote).tokens, Math.max(1, width - 2)).map((chunk) => ({ text: chunk.text.split("\n").map((line) => `│ ${line}`).join("\n"), kind: "tool" }));
      case "list": {
        const list = token as Tokens.List;
        return list.items.flatMap((item, i) => markdownChunks(item.tokens, width).map((chunk, j) => {
          const prefix = `${j === 0 ? list.ordered ? `${Number(list.start || 1) + i}. ` : "• " : "  "}${item.task && j === 0 ? `[${item.checked ? "x" : " "}] ` : ""}`;
          return { ...chunk, text: prefix + chunk.text, ...(chunk.spans ? { spans: chunk.spans.map((span) => ({ ...span, start: span.start + prefix.length, end: span.end + prefix.length })) } : {}) };
        }));
      }
      case "table": {
        const table = token as Tokens.Table;
        const headers = table.header.map((cell) => inline(cell.tokens));
        const rows = table.rows.map((row) => row.map((cell) => inline(cell.tokens)));
        const widths = headers.map((header, i) => Math.max(cellWidth(header), ...rows.map((row) => cellWidth(row[i] ?? ""))));
        if (widths.reduce((sum, size) => sum + size, 0) + Math.max(0, widths.length - 1) * 3 <= width) {
          const format = (cells: string[]) => cells.map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - cellWidth(cell)))).join(" │ ");
          return [{ text: format(headers), kind: "heading" }, { text: widths.map((size) => "─".repeat(size)).join("─┼─"), kind: "tool" }, ...rows.map((row): Chunk => ({ text: format(row), kind: "text" })), { text: "", kind: "text" }];
        }
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
const markdownCache = new WeakMap<ConversationMessage, { text: string; width: number; chunks: Chunk[] }>();
const lineCache = new WeakMap<ConversationMessage, { text: string; width: number; index: number; results: string; lines: ChatLine[] }>();
export function layoutChat(messages: readonly ConversationMessage[], streamingText: string, activeTools: readonly ActiveTool[], width: number, toolPreview = true): ChatLine[] {
  const lines: ChatLine[] = [];
  const results = new Map<string, ToolResultBlock>(messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result").map((result) => [result.toolUseId, result]));
  const gutter = width >= 48 ? 2 : 0;
  const bodyWidth = Math.max(1, width - gutter - 1);
  function append(id: string, text: string, kind: ChatLine["kind"], spans?: InlineSpan[]): void {
    for (const row of wrapRows(sanitizeTerminalText(text), bodyWidth)) {
      const visible = spans?.filter((span) => span.start < row.end && span.end > row.start).map((span) => ({ ...span, start: Math.max(0, span.start - row.start) + gutter, end: Math.min(row.end, span.end) - row.start + gutter }));
      lines.push({ id, offset: row.start, text: " ".repeat(gutter) + row.text, kind, ...(visible?.length ? { spans: visible } : {}) });
    }
  }
  function chunks(id: string, parts: Chunk[]): void {
    parts.forEach((chunk, i) => append(`${id}:${i}`, chunk.text, chunk.kind, chunk.spans));
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
    if (text) append(`${id}:role`, message.role === "user" ? "You" : "QiCode", message.role === "user" ? "user" : "assistant");
    if (text) {
      if (message.role === "user") append(`${id}:text`, text, "text");
      else {
        let cached = markdownCache.get(message);
        if (!cached || cached.text !== text || cached.width !== bodyWidth) {
          cached = { text, width: bodyWidth, chunks: markdownChunks(marked.lexer(sanitizeTerminalText(text)), bodyWidth) };
          markdownCache.set(message, cached);
        }
        chunks(`${id}:text`, cached.chunks);
      }
    }
    for (const tool of tools) {
      const result = results.get(tool.id);
      append(`tool:${tool.id}`, `${result ? result.isError ? "✗" : "✓" : "●"} ${tool.name} ${formatArgs(tool.input)}`, result?.isError ? "error" : "tool");
      if (toolPreview && result?.content) {
        const previewLines = sanitizeTerminalText(result.content).split("\n").filter((line) => line.trim());
        const limit = result.isError ? 4 : 2;
        const preview = previewLines.slice(0, limit).map((line) => `  ${truncateCells(line, Math.max(1, bodyWidth - 2))}`).join("\n");
        append(`result:${tool.id}`, preview + (previewLines.length > limit ? `\n  … 共 ${previewLines.length} 行 · /tasks 查看详情` : ""), result.isError ? "error" : "tool");
      }
    }
    append(`${id}:gap`, "", "text");
    lineCache.set(message, { text, width, index, results: resultKey, lines: lines.slice(start) });
  });
  if (streamingText) {
    const id = `message:${messages.length}`;
    append(`${id}:role`, "QiCode", "assistant");
    chunks(`${id}:text`, markdownChunks(marked.lexer(sanitizeTerminalText(streamingText)), bodyWidth));
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
