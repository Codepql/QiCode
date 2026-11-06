import { Text } from "ink";
import type { PermissionMode } from "../permissions/checker.js";

const MODE_DISPLAY: Record<Exclude<PermissionMode, "default">, {
  name: string;
  color: "green" | "yellow" | "red";
}> = {
  acceptEdits: { name: "Accept Edits", color: "green" },
  plan: { name: "Plan", color: "yellow" },
  bypassPermissions: { name: "manual", color: "red" },
};

export interface StatusBarProps {
  mode: PermissionMode;
  inputTokens?: number;
  outputTokens?: number;
  busy?: boolean;
  teamCount?: number;
  contextTokens?: number;
  contextWindow?: number;
  highContrast?: boolean;
}

export function StatusBar({ mode, inputTokens, outputTokens, busy = false, teamCount = 0, contextTokens, contextWindow, highContrast = false }: StatusBarProps) {
  const modeInfo = mode === "default" ? undefined : MODE_DISPLAY[mode];

  return (
    <Text dimColor={!highContrast} wrap="truncate-end">
      {modeInfo === undefined
        ? <>default | </>
        : <><Text color={modeInfo.color}>{modeInfo.name} on </Text>(shift+tab to cycle) | </>}
      {contextTokens !== undefined ? `上下文≈${contextTokens}/${contextWindow ?? "容量未知"} · ` : ""}累计 ↑ {inputTokens ?? "-"} · ↓ {outputTokens ?? "-"} · {busy ? "Esc 取消" : "Ctrl+C 两次退出"}{teamCount > 0 ? ` · 团队 ${teamCount}` : ""}
    </Text>
  );
}
