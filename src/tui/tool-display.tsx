import { Box, Text } from "ink";
import { sanitizeTerminalText } from "./sanitize-terminal.js";

export interface ToolBlockInfo {
  toolName: string;
  args: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  elapsed?: number;
  loading?: boolean;
}

export function ToolDisplay({ tools }: { tools: readonly ToolBlockInfo[] }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {tools.map((tool, index) => <ToolBlock key={`${tool.toolName}-${index}`} tool={tool} />)}
    </Box>
  );
}

function ToolBlock({ tool }: { tool: ToolBlockInfo }) {
  const summary = formatArgs(tool.args);
  if (tool.loading) {
    return <Text color="magenta">● {tool.toolName}{summary ? ` ${summary}` : ""}</Text>;
  }

  const icon = tool.isError ? "✗" : "✓";
  const color = tool.isError ? "red" : "green";
  const elapsed = tool.elapsed === undefined ? "" : ` (${tool.elapsed.toFixed(1)}s)`;
  const output = tool.output === undefined ? "" : truncate(sanitizeTerminalText(tool.output), 500);
  return (
    <Box flexDirection="column">
      <Text color={color}>{icon} {tool.toolName}{summary ? ` ${summary}` : ""}{elapsed}</Text>
      {output && <Text dimColor>{output}</Text>}
    </Box>
  );
}

export function formatArgs(args: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "pattern", "path"]) {
    const value = args[key];
    if (typeof value === "string" && value) return truncate(value, 80);
  }
  const serialized = JSON.stringify(args);
  return serialized === "{}" ? "" : truncate(serialized, 80);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
