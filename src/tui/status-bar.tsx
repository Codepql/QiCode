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
}

export function StatusBar({ mode, inputTokens, outputTokens }: StatusBarProps) {
  const modeInfo = mode === "default" ? undefined : MODE_DISPLAY[mode];

  return (
    <Text dimColor wrap="truncate-end">
      {modeInfo === undefined
        ? <>default | </>
        : <><Text color={modeInfo.color}>{modeInfo.name} on </Text>(shift+tab to cycle) | </>}
      · ↑ {inputTokens ?? "-"} · ↓ {outputTokens ?? "-"} · Ctrl+C exit
    </Text>
  );
}
