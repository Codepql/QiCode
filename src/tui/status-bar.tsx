import { Box, Text, useWindowSize } from "ink";
import type { PermissionMode } from "../permissions/checker.js";
import { cellWidth } from "./text-layout.js";
import { formatCount, theme } from "./theme.js";

const MODE_DISPLAY: Record<Exclude<PermissionMode, "default">, {
  name: string;
  color: "green" | "yellow" | "red";
}> = {
  acceptEdits: { name: "自动编辑", color: "green" },
  plan: { name: "只读规划", color: "yellow" },
  bypassPermissions: { name: "全放行", color: "red" },
};

export interface StatusBarProps {
  mode: PermissionMode;
  inputTokens?: number;
  outputTokens?: number;
  busy?: boolean;
  teamCount?: number;
  contextTokens?: number;
  contextWindow?: number;
  budgetSource?: string;
  highContrast?: boolean;
  columns?: number;
}

export function StatusBar({ mode, inputTokens, outputTokens, busy = false, teamCount = 0, contextTokens, contextWindow, budgetSource, highContrast = false, columns }: StatusBarProps) {
  const window = useWindowSize(); const width = Math.max(1, (columns ?? window.columns ?? 80) - 1);
  const modeInfo = mode === "default" ? undefined : MODE_DISPLAY[mode];
  const action = busy ? "Esc 取消" : "Ctrl+C 两次退出";
  const context = contextTokens === undefined ? "" : width < 59
    ? ` · 上下文 ${contextWindow === undefined ? "未知" : `${Math.round(contextTokens / contextWindow * 100)}%`}`
    : ` · 上下文≈${formatCount(contextTokens)}/${contextWindow === undefined ? "未知" : formatCount(contextWindow)}${budgetSource === "conservative" ? "(保守)" : budgetSource === "configured" ? "(配置)" : budgetSource === "catalog" ? "(模型资料)" : ""}`;
  const usage = width >= 76 ? ` · 累计 ↑${formatCount(inputTokens)} ↓${formatCount(outputTokens)}` : "";
  const team = teamCount > 0 && width >= 90 ? ` · 团队 ${teamCount}` : "";
  return <Box width={width} justifyContent="space-between">
    <Box width={Math.max(1, width - cellWidth(action) - 2)}><Text dimColor={!highContrast} wrap="truncate-end">
      <Text color={modeInfo?.color ?? theme.muted}>{modeInfo?.name ?? "default"}</Text>{context || ` · ↑${formatCount(inputTokens)} ↓${formatCount(outputTokens)}`}{usage}{team}
    </Text></Box>
    <Text dimColor={!highContrast} wrap="truncate-end">{action}</Text>
  </Box>;
}
