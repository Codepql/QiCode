import { sanitizeTerminalText } from "./sanitize-terminal.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): { text: string; offset: number }[] {
  return Array.from(segmenter.segment(text), (part) => ({ text: part.segment, offset: part.index }));
}

export function cellWidth(text: string): number {
  let width = 0;
  for (const { text: part } of graphemes(text)) {
    const code = part.codePointAt(0) ?? 0;
    if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(part)) continue;
    width += /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(part)
      || (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
        || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
        || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x20000)) ? 2 : 1;
  }
  return width;
}

export interface TextRow { text: string; start: number; end: number }

/** The same cell layout is used for rendering, scrolling, and cursor placement. */
export function wrapRows(value: string, columns: number): TextRow[] {
  const width = Math.max(1, columns);
  const rows: TextRow[] = [];
  let text = "";
  let start = 0;
  let cells = 0;
  for (const part of graphemes(value)) {
    if (part.text === "\n") {
      rows.push({ text, start, end: part.offset });
      start = part.offset + 1;
      text = "";
      cells = 0;
      continue;
    }
    const displayed = part.text === "\t" ? " ".repeat(4 - cells % 4) : part.text;
    const size = cellWidth(displayed);
    if (cells + size > width && text !== "") {
      rows.push({ text, start, end: part.offset });
      start = part.offset;
      text = "";
      cells = 0;
    }
    // A one-column terminal cannot display a wide glyph; keep the source offset.
    text += size > width ? "�" : displayed;
    cells += Math.min(size, width);
  }
  rows.push({ text, start, end: value.length });
  return rows;
}

export function truncateCells(value: string, columns: number): string {
  const clean = sanitizeTerminalText(value).replace(/\n/g, " ");
  if (cellWidth(clean) <= columns) return clean;
  if (columns < 1) return "";
  const row = wrapRows(clean, Math.max(1, columns - 1))[0];
  return columns === 1 ? "…" : `${row?.text ?? ""}…`;
}
