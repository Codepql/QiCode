export function buildPlanModeReminder(): string {
  return [
    "Plan mode is active.",
    "Inspect the codebase and explain the plan before making changes.",
    "Only read-only tools are available in this mode.",
  ].join("\n");
}
