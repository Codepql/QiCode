import { Box, Text, useWindowSize } from "ink";
import { useRef, useState } from "react";
import type { TeammateUIState } from "../teams/progress.js";
import { formatTokens, summarizeActivities } from "../teams/progress.js";
import { useRoutedInput } from "./input-router.js";
import { truncateCells, wrapRows } from "./text-layout.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";

export interface TeamsDialogProps {
  teammates: readonly TeammateUIState[];
  maxHeight?: number;
  columns?: number;
  onClose(): void;
  onKill?(name: string): void;
  onShutdown?(name: string): void;
}
export function TeamsDialog({ teammates, maxHeight = 12, columns, onClose, onKill, onShutdown }: TeamsDialogProps) {
  const window = useWindowSize();
  const width = Math.max(1, (columns ?? window.columns) - 1);
  const count = Math.max(1, maxHeight - 2);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const indexRef = useRef(0);
  const [detail, setDetail] = useState(false);
  const [offset, setOffset] = useState(0);
  const selected = teammates[Math.min(selectedIndex, Math.max(0, teammates.length - 1))];
  const details = wrapRows(sanitizeTerminalText(selected ? `${selected.name}\n团队：${selected.teamName}\n状态：${selected.status}\n活动：${summarizeActivities(selected.progress.recentActivities) || "-"}\n用量：${formatTokens(selected.progress.tokenCount)}` : "没有正在运行的成员"), width);
  useRoutedInput(100, (input, key) => {
    if (key.escape || key.ctrl && input === "c") {
      if (detail) { setDetail(false); setOffset(0); }
      else onClose();
    } else if (detail) {
      const delta = key.wheel ?? (key.pageUp ? -count : key.pageDown ? count : key.upArrow ? -1 : key.downArrow ? 1 : 0);
      setOffset((previous) => Math.max(0, Math.min(details.length - count, previous + delta)));
    } else if (teammates.length) {
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.wheel !== undefined) {
        const delta = key.wheel ?? (key.pageUp ? -count : key.pageDown ? count : key.upArrow ? -1 : 1);
        indexRef.current = Math.max(0, Math.min(teammates.length - 1, indexRef.current + delta)); setSelectedIndex(indexRef.current);
      } else if (key.return) setDetail(true);
      else if (input.toLowerCase() === "k") onKill?.(selected!.name);
      else if (input.toLowerCase() === "s") onShutdown?.(selected!.name);
    }
    return true;
  });
  const first = Math.max(0, selectedIndex - count + 1);
  const top = Math.max(0, Math.min(offset, details.length - count));
  return <Box flexDirection="column" flexShrink={0} width={width}>
    <Text bold color="cyan">团队{detail ? "详情" : "任务"}</Text>
    {detail ? details.slice(top, top + count).map((line, index) => <Text key={index} wrap="truncate-end">{line.text || " "}</Text>)
      : teammates.length === 0 ? <Text dimColor>没有正在运行的成员</Text>
      : teammates.slice(first, first + count).map((member, index) => <Text key={`${member.teamName}:${member.name}`} inverse={first + index === selectedIndex} wrap="truncate-end">
        {truncateCells(`${member.name} · ${member.status} · ${summarizeActivities(member.progress.recentActivities)}`, width)}
      </Text>)}
    <Text dimColor wrap="truncate-end">{detail ? "PgUp/PgDn 查看 · Esc 返回" : "↑↓ 选择 · Enter 详情 · k 停止 · s 关闭 · Esc 返回"}</Text>
  </Box>;
}
