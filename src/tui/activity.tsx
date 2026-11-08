import { Text } from "ink";
import { useEffect, useState } from "react";
import { theme } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ActivityProps {
  active: boolean;
  label?: string;
  startedAt?: number;
}

export function Activity({ active, label = "Thinking", startedAt = Date.now() }: ActivityProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1);
  return <Text wrap="truncate-end"><Text color={theme.accent}>{FRAMES[tick % FRAMES.length]} {label}</Text><Text dimColor> · {elapsed}s</Text></Text>;
}
