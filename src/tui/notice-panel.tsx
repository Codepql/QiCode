import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useRoutedInput } from "./input-router.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";
import { wrapRows } from "./text-layout.js";

export function NoticePanel({ notices, columns, maxHeight, active = true, onExpandedChange }: { notices: readonly string[]; columns: number; maxHeight: number; active?: boolean; onExpandedChange?(open: boolean): void }) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const lines = notices.filter(Boolean).flatMap((notice) => wrapRows(sanitizeTerminalText(notice), Math.max(1, columns - 1)));
  const limit = expanded ? Math.max(1, maxHeight - 1) : Math.min(2, Math.max(1, maxHeight - 1));
  useEffect(() => { if (!lines.length) setExpanded(false); }, [lines.length]);
  useEffect(() => { onExpandedChange?.(active && expanded && lines.length > 0); }, [active, expanded, lines.length, onExpandedChange]);
  useRoutedInput(expanded ? 90 : 30, (input, key) => {
    if (key.ctrl && input === "n" && lines.length) { setExpanded((value) => !value); return true; }
    if (!expanded) return false;
    if (key.escape || key.ctrl && input === "c") { setExpanded(false); return true; }
    const delta = key.wheel ?? (key.pageUp ? -limit : key.pageDown ? limit : key.upArrow ? -1 : key.downArrow ? 1 : 0);
    setOffset((previous) => Math.max(0, Math.min(lines.length - limit, previous + delta)));
    return true;
  }, active);
  if (!lines.length || !active) return null;
  const top = expanded ? Math.max(0, Math.min(offset, lines.length - limit)) : 0;
  return <Box flexDirection="column" flexShrink={0}>
    {lines.slice(top, top + limit).map((line, index) => <Text key={index} color="yellow" wrap="truncate-end">{line.text || " "}</Text>)}
    {lines.length > limit && <Text dimColor wrap="truncate-end">Ctrl+N {expanded ? "收起 · PgUp/PgDn 浏览" : `查看完整通知（${lines.length} 行）`}</Text>}
  </Box>;
}
