import { Box, Text } from "ink";
import { useRef, useState } from "react";
import { useRoutedInput } from "./input-router.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";
import { truncateCells, wrapRows } from "./text-layout.js";
import { theme } from "./theme.js";

export interface Choice { id: string; label: string; detail?: string; search?: string }
export interface ChoiceDialogProps {
  title: string; items: readonly Choice[]; columns: number; maxHeight: number;
  hint?: string; onSelect(id: string): void; onClose(): void;
  onAction?(id: string, action: string): void;
  previewOnEnter?: boolean;
}

/** One consuming modal with bounded list, search and scrollable preview. */
export function ChoiceDialog({ title, items, columns, maxHeight, hint, onSelect, onClose, onAction, previewOnEnter = false }: ChoiceDialogProps) {
  const [query, setQuery] = useState(""); const queryRef = useRef("");
  const [index, setIndex] = useState(0); const selectedRef = useRef(0);
  const [preview, setPreview] = useState(false); const [offset, setOffset] = useState(0);
  const width = Math.max(1, columns - 1); const height = Math.max(1, maxHeight - 4);
  const filtered = items.filter((item) => `${item.label} ${item.search ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const selected = filtered[Math.min(index, Math.max(0, filtered.length - 1))];
  const lines = wrapRows(sanitizeTerminalText(selected?.detail ?? selected?.label ?? "没有匹配项"), width);
  useRoutedInput(100, (input, key) => {
    if (key.escape || key.ctrl && input === "c") {
      if (preview) { setPreview(false); setOffset(0); } else onClose();
    } else if (preview) {
      if (key.ctrl && input === "x" && selected) onAction?.(selected.id, "cancel");
      else if (key.return && selected && !previewOnEnter) onSelect(selected.id);
      else setOffset((value) => Math.max(0, Math.min(Math.max(0, lines.length - height), value + (key.wheel ?? (key.pageDown ? height : key.pageUp ? -height : key.downArrow ? 1 : key.upArrow ? -1 : 0)))));
    } else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.wheel !== undefined) {
      selectedRef.current = Math.max(0, Math.min(filtered.length - 1, selectedRef.current + (key.wheel ?? (key.pageDown ? height : key.pageUp ? -height : key.downArrow ? 1 : -1))));
      setIndex(selectedRef.current);
    } else if (key.tab && selected) { setPreview(true); setOffset(0); }
    else if (key.return) {
      const current = items.filter((item) => `${item.label} ${item.search ?? ""}`.toLowerCase().includes(queryRef.current.toLowerCase()));
      const choice = current[Math.min(selectedRef.current, current.length - 1)]; if (choice) { if (previewOnEnter) { setPreview(true); setOffset(0); } else onSelect(choice.id); }
    } else if (key.ctrl && input === "x" && selected) onAction?.(selected.id, "cancel");
    else if (key.backspace || key.delete) {
      queryRef.current = Array.from(queryRef.current).slice(0, -1).join(""); setQuery(queryRef.current); selectedRef.current = 0; setIndex(0);
    } else if (!key.ctrl && !key.meta && input && queryRef.current.length < 200) {
      queryRef.current += input.replace(/[\x00-\x1f\x7f]/g, ""); setQuery(queryRef.current); selectedRef.current = 0; setIndex(0);
    }
    return true;
  });
  const top = Math.max(0, Math.min(offset, lines.length - height));
  const first = Math.max(0, index - height + 1);
  return <Box flexDirection="column" width={width} flexShrink={0}>
    <Text color={theme.brand} bold wrap="truncate-end">{title}<Text dimColor>{preview ? " · 预览" : ` · ${filtered.length}/${items.length}`}</Text></Text>
    {!preview && <Text wrap="truncate-end"><Text color={theme.accent}>搜索 </Text>{sanitizeTerminalText(query) || <Text dimColor>输入关键词</Text>}</Text>}
    {preview ? lines.slice(top, top + height).map((line, i) => <Text key={i} wrap="truncate-end">{line.text || " "}</Text>)
      : !filtered.length ? <Text dimColor>没有匹配项</Text> : filtered.slice(first, first + height).map((item) => <Text key={item.id} {...(item.id === selected?.id ? { color: theme.accent } : {})} inverse={item.id === selected?.id} wrap="truncate-end">{truncateCells(`${item.id === selected?.id ? "› " : "  "}${sanitizeTerminalText(item.label)}`, width)}</Text>)}
    <Text dimColor wrap="truncate-end">{preview ? "↑↓/PgUp/PgDn 滚动 · Enter 选择 · Esc 返回" : hint ?? "↑↓ 选择 · Tab 预览 · Enter 确认 · Esc 返回"}</Text>
  </Box>;
}
