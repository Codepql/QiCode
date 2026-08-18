import { Text } from "ink";
import type { TeammateUIState } from "../teams/progress.js";
import { formatTokens, summarizeActivities } from "../teams/progress.js";

export function TeammateSpinnerLine({ state, isLast = false, isSelected = false }: {
  state: TeammateUIState;
  isLast?: boolean;
  isSelected?: boolean;
}) {
  const connector = isLast ? "`- " : "|- ";
  const pointer = isSelected ? "> " : "  ";
  const activity = state.status === "running"
    ? summarizeActivities(state.progress.recentActivities) || state.spinnerVerb
    : state.status;
  return <Text>
    {pointer}<Text dimColor>{connector}</Text><Text color="cyan">@{state.name}</Text>: {activity}
    <Text dimColor> | {state.progress.toolUseCount} tools | {formatTokens(state.progress.tokenCount)} tokens</Text>
  </Text>;
}
