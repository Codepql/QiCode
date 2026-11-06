import { Box, Text } from "ink";
import { useRoutedInput } from "./input-router.js";
import { useState } from "react";
import type { ProviderConfig } from "../config/types.js";

export interface ProviderSelectProps {
  providers: readonly ProviderConfig[];
  onSelect(provider: ProviderConfig): void;
}

export function ProviderSelect({ providers, onSelect }: ProviderSelectProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useRoutedInput(100, (input, key) => {
    if (key.ctrl && input === "c") return false;
    if (providers.length === 0) return;
    if (key.upArrow) {
      setSelectedIndex((index) => (index - 1 + providers.length) % providers.length);
    } else if (key.downArrow) {
      setSelectedIndex((index) => (index + 1) % providers.length);
    } else if (key.return) {
      onSelect(providers[selectedIndex]!);
    }
    return true;
  });

  if (providers.length === 0) {
    return <Text color="yellow">No providers configured.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold>Select a provider</Text>
      <Text dimColor>Use ↑/↓ and Enter</Text>
      <Box flexDirection="column" marginTop={1}>
        {providers.map((provider, index) => (
          <Text
            key={provider.name}
            {...(index === selectedIndex ? { color: "cyan" as const } : {})}
          >
            {index === selectedIndex ? "› " : "  "}
            {provider.name} · {provider.protocol} · {provider.model}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
