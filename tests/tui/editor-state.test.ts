import { describe, expect, it } from "vitest";
import { emptyEditor, erase, horizontal, insertText, lineEdge, projectEditor, replaceRange, vertical, MAX_INPUT_BYTES } from "../../src/tui/editor-state.js";
import { cellWidth, wrapRows } from "../../src/tui/text-layout.js";
import { sanitizeTerminalText } from "../../src/tui/sanitize-terminal.js";

describe("terminal editor data integrity", () => {
  it("moves and deletes whole emoji, combining marks and CJK graphemes", () => {
    let state = insertText(emptyEditor(), "中👨‍👩‍👧‍👦e\u0301🇨🇳")!;
    state = erase(state, -1);
    expect(state.value).toBe("中👨‍👩‍👧‍👦e\u0301");
    state = erase(state, -1);
    expect(state.value).toBe("中👨‍👩‍👧‍👦");
    state = horizontal(state, -1);
    expect(state.cursor).toBe(1);
    state = erase(state, 1);
    expect(state.value).toBe("中");
  });

  it("keeps indentation and trailing newlines, normalizes CRLF and removes terminal control payloads", () => {
    const raw = "  开始\r\n\tcode\r\n\u001b]52;c;secret\u0007\u001b[31m红\u001b[0m\n";
    expect(insertText(emptyEditor(), raw, true)?.value).toBe("  开始\n\tcode\n红\n");
    expect(sanitizeTerminalText("ok\u001bPpayload\u001b\\\u009bok")).toBe("okok");
    expect(sanitizeTerminalText("ok\u001b]unclosed")).toBe("ok");
  });

  it("folds independent paste ranges without changing submitted content", () => {
    const first = "a\n".repeat(30);
    const second = "中文\n".repeat(20);
    let state = insertText(emptyEditor(), first, true)!;
    state = insertText(state, "--")!;
    state = insertText(state, second, true)!;
    expect(projectEditor(state).value).toContain("粘贴 #1");
    expect(projectEditor(state).value).toContain("粘贴 #2");
    expect(state.value).toBe(first + "--" + second);
    state = erase(state, -1);
    expect(state.value).toBe(first + "--");
    expect(state.pastes).toHaveLength(1);
    state = { ...state, cursor: 0 };
    state = erase(state, 1);
    expect(state.value).toBe("--");
  });

  it("adjusts ranges when inserting before them and expands them for editing", () => {
    let state = insertText(emptyEditor(), "line\n".repeat(20), true)!;
    state = insertText({ ...state, cursor: 0 }, "prefix ")!;
    expect(state.pastes[0]?.start).toBe(7);
    state = replaceRange(state, 10, 11, "X");
    expect(state.pastes).toHaveLength(0);
    expect(state.value).toContain("X");
  });

  it("rejects oversized UTF-8 insertions atomically", () => {
    const original = insertText(emptyEditor(), "草稿")!;
    expect(insertText(original, "中".repeat(MAX_INPUT_BYTES / 3 + 1), true)).toBeNull();
    expect(original.value).toBe("草稿");
  });

  it("uses display-cell widths for wrapping and visual row movement", () => {
    expect(cellWidth("中👨‍👩‍👧‍👦e\u0301🇨🇳")).toBe(7);
    expect(wrapRows("中文abc", 4).map((row) => row.text)).toEqual(["中文", "abc"]);
    const state = { ...emptyEditor(), value: "中文ab\n12345", cursor: 2 };
    expect(vertical(state, 1, 20).cursor).toBe(9);
    expect(lineEdge({ ...emptyEditor(), value: "\ntext", cursor: 0 }, false).cursor).toBe(0);
    for (const row of wrapRows("中文\t🇨🇳".repeat(20), 7)) expect(cellWidth(row.text)).toBeLessThanOrEqual(7);
  });
});
