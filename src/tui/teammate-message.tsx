import { Box, Text } from "ink";

export type TeammateMessageType = "idle" | "completed" | "text" | "shutdown";

export interface ParsedTeammateMessage {
  from: string;
  content: string;
  type: TeammateMessageType;
}

export function parseTeammateMessage(raw: string): ParsedTeammateMessage | null {
  const match = /^<team-notification team="([A-Za-z0-9_-]+)">\n([\s\S]*?)\n<\/team-notification>$/.exec(raw.trim());
  if (match === null) return null;
  try {
    const messages: unknown = JSON.parse(match[2]!.split("\n").at(-1)!);
    if (!Array.isArray(messages)) return null;
    const first = messages[0] as { from?: unknown; text?: unknown } | undefined;
    if (typeof first?.from !== "string" || typeof first.text !== "string") return null;
    const text = first.text;
    const type: TeammateMessageType = text.startsWith("[idle]")
      ? "idle"
      : text.startsWith("[shutdown]")
        ? "shutdown"
        : text.startsWith("[completed]")
          ? "completed"
          : "text";
    return { from: first.from, content: text.replace(/^\[(?:idle|shutdown|completed)\]\s*/, ""), type };
  } catch {
    return null;
  }
}

export function TeammateMessage({ from, content, type = "text" }: ParsedTeammateMessage) {
  if (type === "idle" || type === "shutdown") return null;
  return (
    <Box flexDirection="column">
      <Text><Text color="cyan">@{from}</Text> <Text color="green">*</Text> {type === "completed" ? "Task completed" : content.split("\n")[0]}</Text>
      {type === "completed" && <Text dimColor>  {content}</Text>}
    </Box>
  );
}
