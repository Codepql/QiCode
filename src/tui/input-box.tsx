import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { Command } from "../commands/commands.js";
import type { CommandUsageTracker } from "../commands/usage-tracker.js";
import type { PermissionMode } from "../permissions/checker.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";

const commandIcons: Record<Command["type"], string> = {
  local: "•",
  local_ui: "◆",
  prompt: "↳",
  skill_fork: "⇱",
};

export interface InputBoxProps {
  disabled?: boolean;
  columns?: number;
  permMode?: PermissionMode;
  commands?: readonly Command[];
  usageTracker?: CommandUsageTracker;
  onSubmit(value: string): void;
}

export function InputBox({
  disabled = false,
  columns,
  commands = [],
  usageTracker,
  onSubmit,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [dropdownDismissed, setDropdownDismissed] = useState(false);

  useEffect(() => {
    setCursor((position) => Math.min(position, value.length));
  }, [value]);

  const dropdown = useMemo(() => {
    if (!value.startsWith("/") || value.includes("\n")) {
      return { commands: [] as Command[], recentCount: 0, query: "" };
    }

    const query = value.slice(1).toLowerCase();
    if (/\s/.test(query)) return { commands: [] as Command[], recentCount: 0, query };

    const sorted = [...commands].sort((left, right) => left.name.localeCompare(right.name));
    if (query === "") {
      const recentNames = usageTracker?.getRecentlyUsed(5) ?? [];
      const recent = recentNames
        .map((name) => sorted.find((command) => command.name === name))
        .filter((command): command is Command => command !== undefined);
      const recentSet = new Set(recent.map((command) => command.name));
      return {
        commands: [...recent, ...sorted.filter((command) => !recentSet.has(command.name))],
        recentCount: recent.length,
        query,
      };
    }

    const matched: Command[] = [];
    const seen = new Set<string>();
    const add = (command: Command): void => {
      if (!seen.has(command.name)) {
        seen.add(command.name);
        matched.push(command);
      }
    };
    for (const command of sorted) if (command.name === query) add(command);
    for (const command of sorted) if (command.aliases.includes(query)) add(command);
    for (const command of sorted) if (command.name.startsWith(query)) add(command);
    for (const command of sorted) {
      if (command.aliases.some((alias) => alias.startsWith(query))) add(command);
    }
    const fuzzyMatches = sorted
      .map((command) => ({ command, score: commandFuzzyScore(query, command) }))
      .filter((match) => match.score >= 0.4)
      .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name));
    for (const match of fuzzyMatches) add(match.command);
    return { commands: matched, recentCount: 0, query };
  }, [commands, usageTracker, value]);

  const showDropdown = value.startsWith("/")
    && !value.includes("\n")
    && !dropdownDismissed;
  const selectedCommand = dropdown.commands[dropdownIndex];
  const ghostText = cursor === value.length
    && dropdown.query !== ""
    && selectedCommand?.name.startsWith(dropdown.query)
    ? selectedCommand.name.slice(dropdown.query.length)
    : "";
  const recentCommands = dropdown.commands.slice(0, dropdown.recentCount);
  const allCommands = dropdown.commands.slice(dropdown.recentCount, 8);

  useInput((input, key) => {
    if (disabled || (key.ctrl && input === "c")) return;

    if ((key.escape || input === "\u001b") && showDropdown) {
      setDropdownDismissed(true);
      setDropdownIndex(0);
      return;
    }
    if (showDropdown && dropdown.commands.length > 0 && key.upArrow) {
      setDropdownIndex((index) => (index - 1 + dropdown.commands.length) % dropdown.commands.length);
      return;
    }
    if (showDropdown && dropdown.commands.length > 0 && key.downArrow) {
      setDropdownIndex((index) => (index + 1) % dropdown.commands.length);
      return;
    }
    if (showDropdown && dropdown.commands.length > 0 && (key.return || key.tab)) {
      const selected = dropdown.commands[dropdownIndex];
      if (selected) {
        const exactMatch = dropdown.query === selected.name
          || selected.aliases.includes(dropdown.query);
        if (key.return && exactMatch) {
          setValue("");
          setCursor(0);
          setDropdownIndex(0);
          onSubmit(value);
          return;
        }
        const nextValue = `/${selected.name} `;
        setValue(nextValue);
        setCursor(nextValue.length);
        setDropdownIndex(0);
        return;
      }
    }
    if (showDropdown && key.tab) {
      setDropdownDismissed(true);
      return;
    }

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
        setDropdownDismissed(false);
        setDropdownIndex(0);
      }
      return;
    }
    if (key.delete) {
      setValue((current) => current.slice(0, cursor) + current.slice(cursor + 1));
      setDropdownDismissed(false);
      setDropdownIndex(0);
      return;
    }
    if (!key.ctrl && !key.meta && input) insert(input);
  });

  function insert(text: string): void {
    setValue((current) => current.slice(0, cursor) + text + current.slice(cursor));
    setCursor((position) => position + text.length);
    setDropdownDismissed(false);
    setDropdownIndex(0);
  }

  const before = sanitizeTerminalText(value.slice(0, cursor));
  const atCursor = sanitizeTerminalText(value[cursor] ?? " ");
  const after = sanitizeTerminalText(value.slice(cursor + 1));

  return (
    <Box flexDirection="column">
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
            {ghostText && <Text dimColor>{ghostText}</Text>}
          </Text>
        )}
      </Box>
      {showDropdown && (
        <Box flexDirection="column" marginLeft={2}>
          {dropdown.commands.length === 0 ? (
            <Text dimColor>No matching commands</Text>
          ) : (
            <>
              {recentCommands.length > 0 && <Text dimColor>RECENTLY USED</Text>}
              {recentCommands.map((command, index) => (
                <Text key={command.name} inverse={index === dropdownIndex}>
                  {commandIcons[command.type]} /{command.name}  {command.description}
                </Text>
              ))}
              {allCommands.length > 0 && dropdown.recentCount > 0 && <Text dimColor>ALL COMMANDS</Text>}
              {allCommands.map((command, index) => {
                const actualIndex = dropdown.recentCount + index;
                return (
                  <Text key={command.name} inverse={actualIndex === dropdownIndex}>
                    {commandIcons[command.type]} /{command.name}  {command.description}
                  </Text>
                );
              })}
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

function commandFuzzyScore(query: string, command: Command): number {
  const nameScore = fuzzyScore(query, command.name);
  const aliasScore = Math.max(0, ...command.aliases.map((alias) => fuzzyScore(query, alias))) * 0.8;
  const descriptionScore = fuzzyScore(query, command.description) * 0.5;
  return Math.max(nameScore, aliasScore, descriptionScore);
}

function fuzzyScore(query: string, value: string): number {
  const normalized = value.toLowerCase();
  let offset = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (const character of query) {
    const index = normalized.indexOf(character, offset);
    if (index === -1) return 0;
    if (firstMatch === -1) firstMatch = index;
    lastMatch = index;
    offset = index + 1;
  }

  const span = lastMatch - firstMatch + 1;
  const compactness = query.length / span;
  const coverage = query.length / normalized.length;
  return compactness * 0.8 + coverage * 0.2;
}
