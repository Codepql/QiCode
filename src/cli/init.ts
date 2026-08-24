import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_TEMPLATE = `# QiCode configuration
# Fill in your API credentials.
base_url: https://api.example.com/v1
token: your-api-token
model: deepseek-v4-flash
`;

const MCP_CONFIG_TEMPLATE = `# MCP server configuration.
mcp_servers: []
`;

/** Creates the one-time, user-wide QiCode configuration. */
export async function initializeGlobalConfig(homeDir: string): Promise<string[]> {
  const qicodeDir = join(homeDir, ".QiCode");
  return initializeConfigDirectory(qicodeDir, "config.yaml", "config.yaml");
}

/** Creates optional templates for configuration specific to one project. */
export async function initializeProject(workDir: string): Promise<string[]> {
  const qicodeDir = join(workDir, ".QiCode");
  return initializeConfigDirectory(qicodeDir, "config.example.yaml", "config.example.yaml");
}

async function initializeConfigDirectory(
  qicodeDir: string,
  configFileName: string,
  mcpConfigFileName: string,
): Promise<string[]> {
  const mcpDir = join(qicodeDir, "mcp-config");
  const skillsDir = join(qicodeDir, "skills");
  await Promise.all([
    mkdir(mcpDir, { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
  ]);

  const created: string[] = [];
  await writeIfMissing(join(qicodeDir, configFileName), CONFIG_TEMPLATE, created);
  await writeIfMissing(join(mcpDir, mcpConfigFileName), MCP_CONFIG_TEMPLATE, created);
  return created;
}

async function writeIfMissing(path: string, content: string, created: string[]): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    created.push(path);
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
