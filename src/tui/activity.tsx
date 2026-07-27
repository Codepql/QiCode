import { Text } from "ink";
import { useEffect, useState } from "react";

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
    const timer = setInterval(() => setTick((value) => value + 1), 80);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1);
  return <Text>{FRAMES[tick % FRAMES.length]} {label}... {elapsed}s</Text>;
}
