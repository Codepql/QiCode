import { Box, Text } from "ink";
import type { TeammateUIState } from "../teams/progress.js";
import { formatTokens } from "../teams/progress.js";
import { TeammateSpinnerLine } from "./teammate-spinner-line.js";

export function TeammateSpinnerTree({ teammates, leaderVerb, leaderTokens }: {
  teammates: readonly TeammateUIState[];
  leaderVerb?: string;
  leaderTokens?: number;
}) {
  if (teammates.length === 0) return null;
  return <Box flexDirection="column">
    <Text color="cyan">  |- team-lead: {leaderVerb ?? "thinking"}... <Text dimColor>{leaderTokens === undefined ? "" : `| ${formatTokens(leaderTokens)} tokens`}</Text></Text>
    {teammates.map((state, index) => (
      <TeammateSpinnerLine key={`${state.teamName}:${state.name}`} state={state} isLast={index === teammates.length - 1} />
    ))}
  </Box>;
}
