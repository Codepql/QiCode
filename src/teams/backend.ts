import { execFileSync, spawn } from "node:child_process";
import type { TeamMode } from "./team.js";

export interface SpawnConfig {
  mode: TeamMode;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface SpawnedTeammate {
  cancel(): void;
}

/** Default selection never probes the user's terminal environment. */
export function detectBackend(): TeamMode {
  return "in-process";
}

/** Terminal probing is opt-in and only used by a caller that explicitly asks. */
export function detectPaneBackend(): TeamMode {
  if (process.env.TMUX) return "tmux";
  try {
    execFileSync("tmux", ["-V"], {
      windowsHide: true,
      timeout: 1_000,
      maxBuffer: 4_096,
    });
    return "tmux";
  } catch {
    return "in-process";
  }
}

/**
 * The in-process backend starts a dedicated teammate command without a shell.
 * Pane-based launch passes a separately quoted command to tmux's shell.
 */
export function spawnTeammate(config: SpawnConfig): SpawnedTeammate {
  if (config.mode === "tmux") {
    const sessionName = `qicode-${Date.now().toString(36)}`;
    const command = [config.command, ...config.args].map(quoteShellArgument).join(" ");
    const child = spawn("tmux", ["new-session", "-d", "-s", sessionName, command], {
      cwd: config.cwd,
      stdio: "ignore",
      env: { ...process.env, ...config.env },
      shell: false,
      windowsHide: true,
    });
    return {
      cancel: () => {
        if (!child.killed) child.kill("SIGTERM");
        const cleanup = spawn("tmux", ["kill-session", "-t", sessionName], {
          stdio: "ignore",
          shell: false,
          windowsHide: true,
        });
        cleanup.on("error", () => {});
      },
    };
  }
  if (config.mode === "iterm") {
    throw new Error("iTerm teammate backend is not supported on this platform");
  }
  if (config.mode !== "in-process") {
    throw new Error(`Unknown team mode: ${config.mode}`);
  }

  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...config.env },
    shell: false,
    windowsHide: true,
  });
  return {
    cancel: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

function quoteShellArgument(value: string): string {
  if (value.includes("\0")) throw new Error("teammate command arguments cannot contain NUL bytes");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
