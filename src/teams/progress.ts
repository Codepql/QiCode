export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
  activityDescription: string;
}

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities: ToolActivity[];
}

export interface TeammateUIState {
  name: string;
  teamName: string;
  status: "running" | "idle" | "completed" | "failed" | "stopped";
  progress: AgentProgress;
  startTime: number;
  spinnerVerb: string;
  lastMessage?: string;
}

const RECENT_ACTIVITY_LIMIT = 5;

export function createProgress(): AgentProgress {
  return {
    toolUseCount: 0,
    tokenCount: 0,
    recentActivities: [],
  };
}

export function recordToolUse(
  progress: AgentProgress,
  toolName: string,
  input: Record<string, unknown>,
): void {
  progress.toolUseCount += 1;
  const activity: ToolActivity = {
    toolName,
    input: structuredClone(input),
    activityDescription: describeToolActivity(toolName, input),
  };
  progress.lastActivity = activity;
  progress.recentActivities.push(activity);
  if (progress.recentActivities.length > RECENT_ACTIVITY_LIMIT) {
    progress.recentActivities.shift();
  }
}

export function recordTokens(
  progress: AgentProgress,
  inputTokens: number,
  outputTokens: number,
): void {
  const input = finiteNonNegative(inputTokens);
  const output = finiteNonNegative(outputTokens);
  progress.tokenCount = input + output;
}

export function summarizeActivities(activities: readonly ToolActivity[]): string {
  return activities.at(-1)?.activityDescription ?? "";
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.trunc(tokens)));
}

function describeToolActivity(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "ReadFile":
      return `Reading ${stringInput(input, "file_path", "file")}`;
    case "EditFile":
      return `Editing ${stringInput(input, "file_path", "file")}`;
    case "WriteFile":
      return `Writing ${stringInput(input, "file_path", "file")}`;
    case "Bash": {
      const command = stringInput(input, "command", "command");
      return `Running ${command.length > 40 ? `${command.slice(0, 40)}...` : command}`;
    }
    case "Glob":
      return `Searching ${stringInput(input, "pattern", "files")}`;
    case "Grep":
      return `Grepping ${stringInput(input, "pattern", "pattern")}`;
    default:
      return toolName;
  }
}

function stringInput(input: Record<string, unknown>, key: string, fallback: string): string {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
