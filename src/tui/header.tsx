import { Box, Text } from "ink";
import { divider, theme } from "./theme.js";

const CAT = [" /\\_/\\", "( o.o )", " > ^ <"] as const;

export interface HeaderProps {
  version: string;
  model: string;
  workDir: string;
  columns?: number;
  rows?: number;
}

export function Header({
  version,
  model,
  workDir,
  columns = process.stdout.columns ?? 80,
  rows = process.stdout.rows ?? 24,
}: HeaderProps) {
  const showCat = columns >= 32 && rows >= 8;
  return (
    <Box flexDirection="column" width={Math.max(1, columns - 1)}>
      <Box flexDirection={showCat ? "row" : "column"}>
      {showCat && (
        <Box flexDirection="column" marginRight={4} flexShrink={0}>
          {CAT.map((line) => <Text key={line} color={theme.brand}>{line}</Text>)}
        </Box>
      )}
      <Box flexDirection="column" width={Math.max(1, columns - 1 - (showCat ? 11 : 0))} minWidth={0}>
        <Text wrap="truncate-end"><Text bold color={theme.brand}>QiCode</Text><Text dimColor> v{version}</Text></Text>
        <Text wrap="truncate-end"><Text dimColor>模型 </Text><Text color={theme.accent}>{model}</Text></Text>
        <Text dimColor wrap="truncate-end">{workDir}</Text>
      </Box>
      </Box>
      {columns >= 40 && <Text color={theme.muted} dimColor wrap="truncate-end">{divider(columns)}</Text>}
    </Box>
  );
}
