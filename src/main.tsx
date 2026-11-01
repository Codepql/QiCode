#!/usr/bin/env node

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import {
  loadConfig,
  loadConfigLayers,
  loadMcpConfigLayers,
  resolveConfigPath,
} from "./config/load-config.js";
import { parseTeammateFlags, runTeammate } from "./teammate.js";
import { App } from "./tui/app.js";
import { initializeGlobalConfig, initializeProject } from "./cli/init.js";
import { VERSION, versionText } from "./version.js";
export { VERSION, versionText } from "./version.js";

const entryPath = process.argv[1];
// npm's Windows and Git Bash shims can normalize the path differently from import.meta.url.
// The executed script name is stable, while test imports have a test runner as argv[1].
if (entryPath && /(?:^|[\\/])main\.(?:js|tsx)$/.test(entryPath)) {
  void main();
}

async function main(): Promise<void> {
  const workDir = process.cwd();
  const args = process.argv.slice(2);
  const teammateArgs = parseTeammateFlags(args);
  try {
    if (args[0] === "--help" || args[0] === "-h") {
      process.stdout.write(helpText());
      return;
    }
    if (args[0] === "--version" || args[0] === "-v") {
      process.stdout.write(`${versionText()}\n`);
      return;
    }
    if (args[0] === "init") {
      const projectScope = args[1] === "--project";
      if (args[1] !== undefined && !projectScope) {
        throw new Error("Usage: qicode init [--project]");
      }
      const created = projectScope
        ? await initializeProject(workDir)
        : await initializeGlobalConfig(homedir());
      process.stdout.write(created.length === 0
        ? "QiCode configuration already exists.\n"
        : `QiCode ${projectScope ? "project" : "global"} configuration initialized:\n${created.map((path) => `  ${path}`).join("\n")}\n`);
      return;
    }
    if (teammateArgs !== null) {
      await runTeammate(teammateArgs);
      return;
    }
    const config = await loadStartupConfig(args);
    const mcpConfig = await loadMcpConfigLayers();
    render(
      <App
        providers={config.providers}
        mcpServers={mcpConfig.mcp_servers}
        hooks={config.hooks}
        workDir={workDir}
      />,
      { exitOnCtrlC: false },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to load configuration";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function helpText(): string {
  return [
    "QiCode - terminal-first AI coding agent",
    "",
    "Usage:",
    "  qicode                 Start QiCode in the current project",
    "  qicode init            Create one-time global configuration",
    "  qicode init --project  Create optional project configuration templates",
    "  qicode --config FILE  Start with an explicit configuration file",
    "  qicode --version       Show the installed version",
    "  qicode --help          Show this help",
    "",
  ].join("\n");
}

async function loadStartupConfig(args: readonly string[]) {
  if (args.length === 0) return loadConfigLayers();
  return loadConfig(resolveConfigPath(args));
}

export async function resolveStartupConfigPath(
  args: readonly string[],
  workDir = process.cwd(),
  homeDir = homedir(),
): Promise<string> {
  if (args.length > 0) {
    return resolveConfigPath(args, homeDir);
  }

  const projectConfig = join(workDir, ".QiCode", "config.yaml");
  try {
    await access(projectConfig);
    return projectConfig;
  } catch {
    return join(homeDir, ".QiCode", "config.yaml");
  }
}
