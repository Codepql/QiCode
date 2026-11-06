import { sanitizeTerminalText } from "./sanitize-terminal.js";
import { cellWidth, graphemes, wrapRows } from "./text-layout.js";

export const MAX_INPUT_BYTES = 1024 * 1024;
export interface PasteRange { id: number; start: number; end: number; collapsed: boolean }
export interface EditorState { value: string; cursor: number; pastes: PasteRange[]; nextPasteId: number; literal: boolean }
export const emptyEditor = (): EditorState => ({ value: "", cursor: 0, pastes: [], nextPasteId: 1, literal: false });

export function replaceRange(state: EditorState, start: number, end: number, text: string): EditorState {
  const delta = text.length - (end - start);
  return {
    ...state,
    value: state.value.slice(0, start) + text + state.value.slice(end),
    cursor: start + text.length,
    pastes: state.pastes.flatMap((part) => {
      if (part.end <= start) return [part];
      if (part.start >= end) return [{ ...part, start: part.start + delta, end: part.end + delta }];
      return []; // Editing an expanded paste makes it ordinary editable text.
    }),
  };
}

export function insertText(state: EditorState, raw: string, pasted = false): EditorState | null {
  const text = sanitizeTerminalText(raw);
  if (Buffer.byteLength(state.value, "utf8") + Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) return null;
  const next = replaceRange(state, state.cursor, state.cursor, text);
  if (pasted) next.literal = true;
  if (pasted && (text.split("\n").length > 10 || text.length > 2000)) {
    next.pastes.push({ id: state.nextPasteId, start: state.cursor, end: state.cursor + text.length, collapsed: true });
    next.pastes.sort((a, b) => a.start - b.start);
    next.nextPasteId += 1;
  }
  return next;
}

export function horizontal(state: EditorState, direction: -1 | 1, word = false): EditorState {
  const folded = state.pastes.find((part) => part.collapsed && (direction < 0 ? part.end === state.cursor : part.start === state.cursor));
  if (folded) return { ...state, cursor: direction < 0 ? folded.start : folded.end };
  const positions = [0, ...graphemes(state.value).map((part) => part.offset + part.text.length)];
  let cursor = state.cursor;
  if (word) {
    const before = state.value.slice(0, cursor);
    const after = state.value.slice(cursor);
    cursor = direction < 0 ? cursor - (before.match(/\S+\s*$|\s+$/u)?.[0].length ?? before.length)
      : cursor + (after.match(/^\s*\S+|^\s+/u)?.[0].length ?? after.length);
  } else {
    cursor = direction < 0 ? positions.filter((position) => position < cursor).at(-1) ?? 0
      : positions.find((position) => position > cursor) ?? state.value.length;
  }
  return { ...state, cursor };
}

export function erase(state: EditorState, direction: -1 | 1, word = false): EditorState {
  const target = horizontal(state, direction, word).cursor;
  return replaceRange(state, Math.min(target, state.cursor), Math.max(target, state.cursor), "");
}

export function projectEditor(state: EditorState): { value: string; cursor: number } {
  let value = "";
  let offset = 0;
  let cursor = state.cursor;
  for (const part of state.pastes.filter((item) => item.collapsed)) {
    const text = state.value.slice(part.start, part.end);
    const label = `[粘贴 #${part.id}：${text.split("\n").length} 行 / ${text.length} 字符]`;
    value += state.value.slice(offset, part.start) + label;
    if (state.cursor >= part.end) cursor += label.length - text.length;
    else if (state.cursor > part.start) cursor = value.length;
    offset = part.end;
  }
  value += state.value.slice(offset);
  return { value, cursor };
}

export function lineEdge(state: EditorState, end: boolean): EditorState {
  return { ...state, cursor: end ? state.value.indexOf("\n", state.cursor) < 0 ? state.value.length : state.value.indexOf("\n", state.cursor)
    : state.cursor === 0 ? 0 : state.value.lastIndexOf("\n", state.cursor - 1) + 1 };
}

/** Move by visual rows. Collapsed blocks are atomic until explicitly expanded. */
export function vertical(state: EditorState, direction: -1 | 1, width: number): EditorState {
  const expanded = { ...state, pastes: state.pastes.map((part) => ({ ...part, collapsed: false })) };
  const rows = wrapRows(state.value, width);
  const index = rows.findIndex((row, i) => state.cursor >= row.start && (state.cursor < row.end || i === rows.length - 1 || state.value[row.end] === "\n" && state.cursor === row.end));
  const row = rows[Math.max(0, index)]!;
  const target = rows[Math.max(0, Math.min(rows.length - 1, index + direction))]!;
  const column = cellWidth(wrapRows(state.value.slice(row.start, state.cursor), width)[0]?.text ?? "");
  let cells = 0;
  let cursor = target.start;
  for (const part of graphemes(state.value.slice(target.start, target.end))) {
    const size = part.text === "\t" ? 4 - cells % 4 : cellWidth(part.text);
    if (cells + size > column) break;
    cells += size;
    cursor = target.start + part.offset + part.text.length;
  }
  return { ...expanded, cursor };
}
