#!/usr/bin/env node

import { pathToFileURL } from "node:url";
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
export { VERSION, versionText } from "./version.js";

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const teammateArgs = parseTeammateFlags(args);
  try {
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
      />,
      { exitOnCtrlC: false },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to load configuration";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
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
