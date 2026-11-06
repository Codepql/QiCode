import { Box, Text, measureElement, useBoxMetrics, useCursor, usePaste, useWindowSize, type DOMElement } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Command } from "../commands/commands.js";
import type { CommandUsageTracker } from "../commands/usage-tracker.js";
import type { PermissionMode } from "../permissions/checker.js";
import { emptyEditor, erase, horizontal, insertText, lineEdge, projectEditor, replaceRange, vertical, type EditorState } from "./editor-state.js";
import { useRoutedInput } from "./input-router.js";
import { cellWidth, truncateCells, wrapRows } from "./text-layout.js";

export interface InputBoxProps {
  disabled?: boolean;
  columns?: number;
  maxRows?: number;
  maxSuggestions?: number;
  historyKey?: string;
  compact?: boolean;
  permMode?: PermissionMode;
  commands?: readonly Command[];
  usageTracker?: CommandUsageTracker;
  onSubmit(value: string, options?: { literal: boolean }): void;
}

export function InputBox({ disabled = false, columns, maxRows = 8, maxSuggestions = 8, historyKey = "", compact = false, commands = [], usageTracker, onSubmit }: InputBoxProps) {
  const window = useWindowSize();
  const width = Math.max(1, (columns ?? window.columns ?? 80) - 3);
  const [editor, setEditor] = useState(emptyEditor);
  const state = useRef(editor);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const selectedIndex = useRef(0);
  const [dismissed, setDismissed] = useState(false);
  const dismissedRef = useRef(false);
  const [pasteMode, setPasteMode] = useState(false);
  const pasteModeRef = useRef(false);
  const [notice, setNotice] = useState("");
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const draft = useRef(emptyEditor());
  const inputRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(inputRef);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const { setCursorPosition } = useCursor();

  useEffect(() => { history.current = []; historyIndex.current = -1; }, [historyKey]);
  function update(next: EditorState): void {
    // A cursor reached through line/word navigation must never stay hidden
    // inside a folded paste. Reveal that range before the next edit.
    next = { ...next, pastes: next.pastes.map((part) => part.collapsed && next.cursor > part.start && next.cursor < part.end ? { ...part, collapsed: false } : part) };
    state.current = next; setEditor(next);
  }
  function dismiss(value: boolean): void { dismissedRef.current = value; setDismissed(value); }
  function manualPaste(value: boolean): void { pasteModeRef.current = value; setPasteMode(value); }
  function resetCandidates(): void { selectedIndex.current = 0; setDropdownIndex(0); dismiss(false); }
  function insert(text: string, pasted = false): void {
    const next = insertText(state.current, text, pasted);
    if (!next) { setNotice("输入超过 1 MiB，本次插入已拒绝，原草稿保留"); return; }
    update(next); resetCandidates(); setNotice("");
  }

  const query = editor.value.startsWith("/") ? editor.value.slice(1).toLowerCase() : "";
  const candidates = useMemo(() => completions(query, commands, usageTracker), [commands, query, usageTracker]);
  const showDropdown = !disabled && !pasteMode && !editor.literal && editor.value.startsWith("/") && !/\s/.test(query) && !dismissed;
  const projected = projectEditor(editor);
  const display = projected.value.slice(0, projected.cursor) + (projected.value[projected.cursor] === "\n" ? " " : "")
    + projected.value.slice(projected.cursor) + (projected.cursor === projected.value.length ? " " : "");
  const rows = wrapRows(display, width);
  const cursorRow = Math.max(0, rows.findIndex((row, index) => projected.cursor >= row.start && (projected.cursor < row.end || index === rows.length - 1)));
  const visibleHeight = Math.max(1, Math.min(maxRows, rows.length));
  const top = Math.max(0, cursorRow - visibleHeight + 1);
  const shown = rows.slice(top, top + visibleHeight);
  const cursorColumn = cellWidth(wrapRows(projected.value.slice(rows[cursorRow]!.start, projected.cursor), width)[0]?.text ?? "");

  useEffect(() => {
    if (!inputRef.current) return;
    const position = measureElement(inputRef.current);
    setOrigin((previous) => previous.x === position.x && previous.y === position.y ? previous : { x: position.x, y: position.y });
  });
  // Ink commits this ref in useInsertionEffect; set it during render rather than
  // in a later layout effect (which would leave the IME one keystroke behind).
  setCursorPosition(disabled || !metrics.hasMeasured ? undefined : {
    x: origin.x + 2 + Math.min(width - 1, cursorColumn), y: origin.y + cursorRow - top,
  });

  // Keep the paste channel mounted even while disabled, so pasted bytes cannot
  // fall through to approval shortcuts or the application's global shortcuts.
  usePaste((text) => { if (!disabled) insert(text, true); });

  useRoutedInput(20, (input, key) => {
    if (disabled || key.wheel !== undefined) return false;
    // Input packets can arrive before React commits the previous event.
    const currentQuery = state.current.value.startsWith("/") ? state.current.value.slice(1).toLowerCase() : "";
    const currentDropdown = !pasteModeRef.current && !state.current.literal && state.current.value.startsWith("/") && !/\s/.test(currentQuery) && !dismissedRef.current;
    const currentCandidates = currentQuery === query ? candidates : completions(currentQuery, commands, usageTracker);
    if (key.ctrl && (input === "c" || input === "t") || key.tab && key.shift) return false;
    if ((key.ctrl || key.meta) && input === "v") { manualPaste(!pasteModeRef.current); dismiss(true); return true; }
    if (key.ctrl && input === "o") {
      const collapse = state.current.pastes.some((part) => !part.collapsed);
      const inside = state.current.pastes.find((part) => state.current.cursor > part.start && state.current.cursor < part.end);
      update({ ...state.current, cursor: collapse && inside ? inside.end : state.current.cursor, pastes: state.current.pastes.map((part) => ({ ...part, collapsed: collapse })) }); return true;
    }
    if (key.escape) {
      if (currentDropdown) { dismiss(true); return true; }
      if (pasteModeRef.current) { manualPaste(false); return true; }
      if (notice) { setNotice(""); return true; }
      return false;
    }
    if (key.pageUp || key.pageDown || key.ctrl && (key.home || key.end)) { if (!currentDropdown) return false; }
    if (currentDropdown && currentCandidates.length && (key.upArrow || key.downArrow || key.pageUp || key.pageDown)) {
      const step = key.pageUp || key.pageDown ? Math.max(1, maxSuggestions) : 1;
      selectedIndex.current = (selectedIndex.current + (key.upArrow || key.pageUp ? -step : step) + currentCandidates.length * 2) % currentCandidates.length;
      setDropdownIndex(selectedIndex.current); return true;
    }
    if (input === "\n" || key.ctrl && input === "j" || key.return && (key.shift || key.meta)) { insert("\n", pasteModeRef.current); return true; }
    if (key.return && pasteModeRef.current) { insert("\n", true); return true; }
    if (key.return || key.tab) {
      const selected = currentCandidates[Math.min(selectedIndex.current, currentCandidates.length - 1)];
      if (currentDropdown && selected && (key.tab || currentQuery !== selected.name && !selected.aliases.includes(currentQuery))) {
        update({ ...emptyEditor(), value: `/${selected.name} `, cursor: selected.name.length + 2 }); resetCandidates(); return true;
      }
      if (key.tab) return true;
      const current = state.current;
      if (current.value.trim()) {
        if (history.current.at(-1) !== current.value) history.current = [...history.current, current.value].slice(-100);
        historyIndex.current = -1; update(emptyEditor()); resetCandidates();
        onSubmit(current.value, { literal: current.literal });
      }
      return true;
    }
    if (key.leftArrow || key.rightArrow) { update(horizontal(state.current, key.leftArrow ? -1 : 1, key.ctrl || key.meta)); return true; }
    if (key.home || key.end || key.ctrl && (input === "a" || input === "e")) { update(lineEdge(state.current, key.end || input === "e")); return true; }
    if (key.upArrow || key.downArrow) {
      const current = state.current;
      const projected = projectEditor(current);
      const visualRows = wrapRows(projected.value, width);
      const visualIndex = visualRows.findIndex((row, index) => projected.cursor >= row.start && (projected.cursor < row.end || index === visualRows.length - 1 || projected.value[row.end] === "\n" && projected.cursor === row.end));
      const atBoundary = key.upArrow ? visualIndex === 0 : visualIndex === visualRows.length - 1;
      if (atBoundary && history.current.length) {
        if (historyIndex.current < 0) {
          if (key.downArrow) return true;
          draft.current = current; historyIndex.current = history.current.length;
        }
        historyIndex.current = Math.max(0, Math.min(history.current.length, historyIndex.current + (key.upArrow ? -1 : 1)));
        const value = history.current[historyIndex.current];
        if (value === undefined) { update(draft.current); historyIndex.current = -1; }
        else update({ ...emptyEditor(), value, cursor: value.length, literal: true });
      } else update(vertical(current, key.upArrow ? -1 : 1, width));
      return true;
    }
    if (key.backspace || key.delete || key.ctrl && input === "w") {
      update(erase(state.current, key.delete ? 1 : -1, key.ctrl || key.meta)); resetCandidates(); return true;
    }
    if (key.ctrl && (input === "u" || input === "k")) {
      const current = state.current;
      const edge = lineEdge(current, input === "k").cursor;
      update(replaceRange(current, Math.min(edge, current.cursor), Math.max(edge, current.cursor), "")); resetCandidates(); return true;
    }
    if (!key.ctrl && !key.meta && input) { insert(input, pasteModeRef.current || input.includes("\n") || input.includes("\r")); return true; }
    return false;
  });

  const count = Math.max(1, maxSuggestions);
  const selected = Math.min(dropdownIndex, candidates.length - 1);
  const first = Math.max(0, Math.min(candidates.length - count, selected - count + 1));
  return (
    <Box flexDirection="column" width={Math.max(3, (columns ?? window.columns ?? 80) - 1)} flexShrink={0}>
      <Box ref={inputRef} flexDirection="column">
        {shown.map((row, index) => <Text key={index} wrap="truncate-end"><Text color={disabled ? "gray" : "cyan"}>{index === 0 ? "> " : "· "}</Text>{row.text}</Text>)}
      </Box>
      {disabled && !compact && <Text dimColor wrap="truncate-end">等待执行结束… Esc 取消</Text>}
      {pasteMode && !disabled && <Text color="yellow" wrap="truncate-end">粘贴模式：Enter 换行，Alt+V 结束后 Enter 发送</Text>}
      {notice && !disabled && <Text color="yellow" wrap="truncate-end">{notice}</Text>}
      {editor.pastes.length > 0 && !compact && <Text dimColor wrap="truncate-end">Ctrl+O 展开/折叠粘贴；边界处退格移除</Text>}
      {showDropdown && <Box flexDirection="column">
        {candidates.length === 0 ? <Text dimColor>没有匹配的命令</Text> : candidates.slice(first, first + count).map((command, index) =>
          <Text key={command.name} inverse={first + index === selected} wrap="truncate-end">{truncateCells(`/${command.name}  ${command.description}`, width + 2)}</Text>)}
        {candidates.length > count && <Text dimColor wrap="truncate-end">{selected + 1}/{candidates.length} · ↑↓ 选择 · Tab 补全</Text>}
      </Box>}
    </Box>
  );
}

function completions(query: string, commands: readonly Command[], tracker?: CommandUsageTracker): Command[] {
  const recent = tracker?.getRecentlyUsed(5) ?? [];
  return commands.map((command) => ({ command, score: completionScore(query, command) })).filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score
      || (recent.includes(a.command.name) ? recent.indexOf(a.command.name) : 99) - (recent.includes(b.command.name) ? recent.indexOf(b.command.name) : 99)
      || a.command.name.localeCompare(b.command.name)).map(({ command }) => command);
}

function completionScore(query: string, command: Command): number {
  if (query === "") return 0;
  if (command.name === query) return 5;
  if (command.aliases.includes(query)) return 4;
  if (command.name.startsWith(query)) return 3;
  if (command.aliases.some((name) => name.startsWith(query))) return 2;
  let offset = 0;
  for (const char of query) {
    const index = command.name.toLowerCase().indexOf(char, offset);
    if (index < 0) return command.description.toLowerCase().includes(query) ? 0 : -1;
    offset = index + 1;
  }
  return 1;
}
