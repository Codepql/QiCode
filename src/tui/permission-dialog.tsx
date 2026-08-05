import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type PermissionAction = "allow" | "deny" | "allowAlways";

const OPTIONS: { label: string; action: PermissionAction }[] = [
  { label: "Yes", action: "allow" },
  { label: "Yes, and don't ask again for this pattern", action: "allowAlways" },
  { label: "No", action: "deny" },
];

export interface PermissionDialogProps {
  toolName: string;
  argsSummary: string;
  reason: string;
  onComplete: (action: PermissionAction) => void;
}

/**
 * 人在回路（HITL）多行确认块：↑↓ 循环移动光标、Enter 提交、Esc 等同拒绝。
 * 用户选择通过 onComplete 回传给 Agent 的 Promise 桥。
 */
export function PermissionDialog({
  toolName,
  argsSummary,
  reason,
  onComplete,
}: PermissionDialogProps) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((current) => (current > 0 ? current - 1 : OPTIONS.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => (current < OPTIONS.length - 1 ? current + 1 : 0));
      return;
    }
    if (key.return) {
      onComplete(OPTIONS[cursor]!.action);
      return;
    }
    if (key.escape) {
      onComplete("deny");
      return;
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold color="yellow">{`  ${toolName} command`}</Text>
      <Text> </Text>
      {argsSummary !== "" && <Text dimColor>{truncate(argsSummary, 120)}</Text>}
      <Text> </Text>
      <Text dimColor>  This command requires approval</Text>
      <Text> </Text>
      <Text>  Do you want to proceed?</Text>
      {OPTIONS.map((option) => {
        const selected = option.action === OPTIONS[cursor]!.action;
        return selected ? (
          <Text key={option.label} color="cyan">  › {option.label}</Text>
        ) : (
          <Text key={option.label} dimColor>    {option.label}</Text>
        );
      })}
      <Text> </Text>
      <Text dimColor>  reason: {reason}</Text>
      <Text> </Text>
    </Box>
  );
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}