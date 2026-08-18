import { Text } from "ink";

export function TeamStatus({ count }: { count: number }) {
  if (count === 0) return null;
  return <Text dimColor><Text color="magenta">*</Text> {count} {count === 1 ? "teammate" : "teammates"}</Text>;
}
