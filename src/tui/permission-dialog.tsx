import { Box, Text, useWindowSize } from "ink";
import { useRef, useState } from "react";
import { useRoutedInput } from "./input-router.js";
import { truncateCells, wrapRows } from "./text-layout.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";
import type { PermissionResponse } from "../permissions/checker.js";

export type PermissionAction = PermissionResponse;
const OPTIONS: { label: string; action: PermissionAction }[] = [
  { label: "[Y] 允许本次", action: "allow" },
  { label: "[A] 允许并记住这条操作", action: "allowAlways" },
  { label: "[N] 拒绝本次", action: "deny" },
  { label: "[T] 本次任务允许编辑和普通命令", action: "allowTask" },
];
export interface PermissionDialogProps {
  toolName: string;
  argsSummary: string;
  reason: string;
  maxHeight?: number;
  columns?: number;
  allowTask?: boolean;
  onComplete(action: PermissionAction): void;
}

export function PermissionDialog({ toolName, argsSummary, reason, maxHeight, columns, allowTask = false, onComplete }: PermissionDialogProps) {
  const options = allowTask
    ? [OPTIONS[3]!, ...OPTIONS.slice(0, 3)]
    : OPTIONS.filter((option) => option.action !== "allowTask");
  const window = useWindowSize();
  const width = Math.max(1, (columns ?? window.columns) - 1);
  const details = wrapRows(sanitizeTerminalText(`${argsSummary}\n原因：${reason}`), width);
  const detailHeight = Math.max(1, (maxHeight ?? 12) - options.length - 2);
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [offset, setOffset] = useState(0);
  const answered = useRef(false);
  useRoutedInput(200, (input, key) => {
    if (answered.current) return true;
    const shortcut = !key.ctrl && !key.meta ? input.toLowerCase() : "";
    if (["y", "a", "n"].includes(shortcut) || shortcut === "t" && allowTask) {
      answered.current = true;
      onComplete(shortcut === "y" ? "allow" : shortcut === "a" ? "allowAlways" : shortcut === "t" ? "allowTask" : "deny");
      return true;
    }
    if (key.pageUp || key.pageDown || key.wheel !== undefined) {
      setOffset((current) => Math.max(0, Math.min(details.length - detailHeight, current + (key.wheel ?? (key.pageUp ? -detailHeight : detailHeight)))));
    } else if (key.upArrow || key.downArrow) {
      cursorRef.current = (cursorRef.current + (key.upArrow ? -1 : 1) + options.length) % options.length;
      setCursor(cursorRef.current);
    } else if (key.return || key.escape || key.ctrl && input === "c") {
      answered.current = true;
      onComplete(key.return ? options[cursorRef.current]!.action : "deny");
    }
    return true; // Modal consumes every key, including app-wide shortcuts.
  });
  const top = Math.max(0, Math.min(offset, details.length - detailHeight));
  return <Box flexDirection="column" flexShrink={0} width={width}>
    <Text bold color="yellow" wrap="truncate-end">{truncateCells(`${toolName} 需要授权`, width)}</Text>
    {details.slice(top, top + detailHeight).map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line.text || " "}</Text>)}
    {options.map((option, index) => <Text key={option.action} inverse={cursor === index} wrap="truncate-end">{cursor === index ? "› " : "  "}{option.label}</Text>)}
    <Text dimColor wrap="truncate-end">{allowTask ? "Enter/T 批准本任务 · Y 仅本次" : "Y 本次"} · A 记住 · N/Esc 拒绝{details.length > detailHeight ? " · PgUp/PgDn 详情" : ""}</Text>
  </Box>;
}
