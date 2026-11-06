import { Box, Text, useWindowSize } from "ink";
import { useRef, useState } from "react";
import { useRoutedInput } from "./input-router.js";
import { truncateCells, wrapRows } from "./text-layout.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";

export type PermissionAction = "allow" | "deny" | "allowAlways";
const OPTIONS: { label: string; action: PermissionAction }[] = [
  { label: "允许本次", action: "allow" },
  { label: "允许并记住此规则", action: "allowAlways" },
  { label: "拒绝本次", action: "deny" },
];
export interface PermissionDialogProps {
  toolName: string;
  argsSummary: string;
  reason: string;
  maxHeight?: number;
  columns?: number;
  onComplete(action: PermissionAction): void;
}

export function PermissionDialog({ toolName, argsSummary, reason, maxHeight, columns, onComplete }: PermissionDialogProps) {
  const window = useWindowSize();
  const width = Math.max(1, (columns ?? window.columns) - 1);
  const details = wrapRows(sanitizeTerminalText(`${argsSummary}\n原因：${reason}`), width);
  const detailHeight = Math.max(1, (maxHeight ?? 12) - 5);
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [offset, setOffset] = useState(0);
  const answered = useRef(false);
  useRoutedInput(200, (input, key) => {
    if (answered.current) return true;
    if (key.pageUp || key.pageDown || key.wheel !== undefined) {
      setOffset((current) => Math.max(0, Math.min(details.length - detailHeight, current + (key.wheel ?? (key.pageUp ? -detailHeight : detailHeight)))));
    } else if (key.upArrow || key.downArrow) {
      cursorRef.current = (cursorRef.current + (key.upArrow ? -1 : 1) + OPTIONS.length) % OPTIONS.length;
      setCursor(cursorRef.current);
    } else if (key.return || key.escape || key.ctrl && input === "c") {
      answered.current = true;
      onComplete(key.return ? OPTIONS[cursorRef.current]!.action : "deny");
    }
    return true; // Modal consumes every key, including app-wide shortcuts.
  });
  const top = Math.max(0, Math.min(offset, details.length - detailHeight));
  return <Box flexDirection="column" flexShrink={0} width={width}>
    <Text bold color="yellow" wrap="truncate-end">{truncateCells(`${toolName} 需要授权`, width)}</Text>
    {details.slice(top, top + detailHeight).map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line.text || " "}</Text>)}
    {OPTIONS.map((option, index) => <Text key={option.action} inverse={cursor === index} wrap="truncate-end">{cursor === index ? "› " : "  "}{option.label}</Text>)}
    <Text dimColor wrap="truncate-end">↑↓ 选择 · Enter 确认 · Esc 拒绝{details.length > detailHeight ? " · PgUp/PgDn 查看详情" : ""}</Text>
  </Box>;
}
