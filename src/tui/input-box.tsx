import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { PermissionMode } from "../permissions/checker.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";

const MODE_DISPLAY: Record<string, { name: string; color: string }> = {
  default: { name: "default", color: "gray" },
  acceptEdits: { name: "Accept Edits", color: "green" },
  plan: { name: "Plan", color: "yellow" },
  bypassPermissions: { name: "manual", color: "red" },
};

export interface InputBoxProps {
  disabled?: boolean;
  columns?: number;
  permMode?: PermissionMode;
  onSubmit(value: string): void;
}

export function InputBox({ disabled = false, columns, permMode, onSubmit }: InputBoxProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    setCursor((position) => Math.min(position, value.length));
  }, [value]);

  useInput((input, key) => {
    if (disabled || (key.ctrl && input === "c")) return;

    if (key.return) {
      const submitted = value.trim();
      if (submitted) {
        setValue("");
        setCursor(0);
        onSubmit(value);
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((position) => Math.max(0, position - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((position) => Math.min(value.length, position + 1));
      return;
    }
    if (key.backspace) {
      if (cursor > 0) {
        setValue((current) => current.slice(0, cursor - 1) + current.slice(cursor));
        setCursor((position) => position - 1);
      }
      return;
    }
    if (key.delete) {
      setValue((current) => current.slice(0, cursor) + current.slice(cursor + 1));
      return;
    }
    if (!key.ctrl && !key.meta && input) insert(input);
  });

  function insert(text: string): void {
    setValue((current) => current.slice(0, cursor) + text + current.slice(cursor));
    setCursor((position) => position + text.length);
  }

  const before = sanitizeTerminalText(value.slice(0, cursor));
  const atCursor = sanitizeTerminalText(value[cursor] ?? " ");
  const after = sanitizeTerminalText(value.slice(cursor + 1));

  const modeInfo = permMode === undefined ? undefined : MODE_DISPLAY[permMode];

  return (
    <Box flexDirection="column">
      {modeInfo !== undefined && permMode !== "default" && (
        <Text>
          <Text color={modeInfo.color}>{modeInfo.name} on </Text>
          <Text dimColor>(shift+tab to cycle)</Text>
        </Text>
      )}
      <Box
        flexDirection="row"
        marginRight={1}
        {...(columns === undefined ? {} : { width: Math.max(4, columns - 1) })}
      >
        <Text color={disabled ? "gray" : "cyan"}>&gt; </Text>
        {disabled ? (
          <Text dimColor>Waiting for response...</Text>
        ) : (
          <Text>
            {before}<Text inverse>{atCursor}</Text>{after}
          </Text>
        )}
      </Box>
    </Box>
  );
}
