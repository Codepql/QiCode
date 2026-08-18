import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { TeammateUIState } from "../teams/progress.js";
import { formatTokens, summarizeActivities } from "../teams/progress.js";
import { TeammateSpinnerLine } from "./teammate-spinner-line.js";

export interface TeamsDialogProps {
  teammates: readonly TeammateUIState[];
  onClose(): void;
  onKill?(name: string): void;
  onShutdown?(name: string): void;
}

export function TeamsDialog({ teammates, onClose, onKill, onShutdown }: TeamsDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detail, setDetail] = useState(false);
  const selected = teammates[Math.min(selectedIndex, Math.max(0, teammates.length - 1))];

  useInput((input, key) => {
    if (key.escape) {
      if (detail) setDetail(false);
      else onClose();
      return;
    }
    if (detail || teammates.length === 0) return;
    if (key.upArrow) setSelectedIndex((index) => Math.max(0, index - 1));
    if (key.downArrow) setSelectedIndex((index) => Math.min(teammates.length - 1, index + 1));
    if (key.return) setDetail(true);
    if (input.toLowerCase() === "k") onKill?.(selected!.name);
    if (input.toLowerCase() === "s") onShutdown?.(selected!.name);
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Teams</Text>
      {teammates.length === 0 && <Text dimColor>No active teammates.</Text>}
      {!detail && teammates.map((state, index) => (
        <TeammateSpinnerLine key={`${state.teamName}:${state.name}`} state={state} isLast={index === teammates.length - 1} isSelected={index === selectedIndex} />
      ))}
      {detail && selected !== undefined && (
        <Box flexDirection="column">
          <TeammateSpinnerLine state={selected} isSelected />
          <Text>Team: {selected.teamName}</Text>
          <Text>Status: {selected.status}</Text>
          <Text>Activity: {summarizeActivities(selected.progress.recentActivities) || "-"}</Text>
          <Text>Tokens: {formatTokens(selected.progress.tokenCount)}</Text>
          <Text dimColor>Esc back</Text>
        </Box>
      )}
      {!detail && teammates.length > 0 && <Text dimColor>Up/Down select | Enter details | k kill | s shutdown | Esc close</Text>}
    </Box>
  );
}
