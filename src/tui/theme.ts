/** Semantic ANSI colors follow the user's terminal palette on light and dark themes. */
export const theme = {
  brand: "magenta", accent: "cyan", success: "green", warning: "yellow", danger: "red", muted: "gray",
} as const;

export function formatCount(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
}
export function divider(columns: number): string { return "─".repeat(Math.max(1, columns - 1)); }
