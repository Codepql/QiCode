import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_EXAMPLE = `# QiCode project configuration
# Copy this file to config.local.yaml and fill in your API credentials.
base_url: https://api.example.com/v1
token: your-api-token
model: deepseek-v4-flash
`;

const MCP_CONFIG_EXAMPLE = `# MCP servers used by this project.
# Copy this file to config.local.yaml before adding private values.
mcp_servers: []
`;

export async function initializeProject(workDir: string): Promise<string[]> {
  const qicodeDir = join(workDir, ".QiCode");
  const mcpDir = join(qicodeDir, "mcp-config");
  const skillsDir = join(qicodeDir, "skills");
  await Promise.all([
    mkdir(mcpDir, { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
  ]);

  const created: string[] = [];
  await writeIfMissing(join(qicodeDir, "config.example.yaml"), CONFIG_EXAMPLE, created);
  await writeIfMissing(join(mcpDir, "config.example.yaml"), MCP_CONFIG_EXAMPLE, created);
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
