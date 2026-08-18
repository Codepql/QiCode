import type { TeamManager } from "./team.js";

const COORDINATOR_ALLOWED_TOOLS = new Set([
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "ListTeams",
  "SpawnTeammate",
  "ReadFile",
  "Glob",
  "Grep",
  "Bash",
]);

export function isCoordinatorTool(name: string): boolean {
  return COORDINATOR_ALLOWED_TOOLS.has(name);
}

export function coordinatorToolFilter(manager: TeamManager): (name: string) => boolean {
  return (name) => {
    if (!manager.hasTeams()) return true;
    if (name.startsWith("mcp__")) return true;
    return isCoordinatorTool(name);
  };
}
