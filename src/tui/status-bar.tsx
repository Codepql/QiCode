import { Text } from "ink";

export interface StatusBarProps {
  mode: string;
  inputTokens?: number;
  outputTokens?: number;
}

export function StatusBar({ mode, inputTokens, outputTokens }: StatusBarProps) {
  return (
    <Text dimColor wrap="truncate-end">
      {mode} · ↑ {inputTokens ?? "-"} · ↓ {outputTokens ?? "-"} · Ctrl+C exit
    </Text>
  );
}
