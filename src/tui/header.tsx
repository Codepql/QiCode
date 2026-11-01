import { Box, Text } from "ink";

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
    <Box flexDirection={showCat ? "row" : "column"} marginBottom={1}>
      {showCat && (
        <Box flexDirection="column" marginRight={4}>
          {CAT.map((line) => <Text key={line} color="magenta">{line}</Text>)}
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold color="magenta">QiCode v{version}</Text>
        <Text>{model}</Text>
        <Text dimColor wrap="truncate-end">{workDir}</Text>
      </Box>
    </Box>
  );
}
