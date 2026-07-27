import { Text } from "ink";

export interface StatusBarProps {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export function StatusBar({ model, inputTokens, outputTokens }: StatusBarProps) {
  return (
    <Text dimColor wrap="truncate-end">
      {model} · ↑ {inputTokens ?? "-"} · ↓ {outputTokens ?? "-"} · Ctrl+C exit
    </Text>
  );
}
