import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import type {
  AppConfig,
  MCPConfig,
  MCPServerConfig,
  Protocol,
  ProviderConfig,
} from "./types.js";

const PROVIDER_FIELDS = new Set([
  "name",
  "protocol",
  "model",
  "base_url",
  "api_key",
  "thinking",
]);

const MCP_SERVER_FIELDS = new Set([
  "name",
  "command",
  "args",
  "url",
  "transport",
  "headers",
  "env",
]);

const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function resolveConfigPath(
  args: readonly string[],
  homeDirectory = homedir(),
): string {
  if (args.length === 0) {
    return join(homeDirectory, ".QiCode", "config.yaml");
  }

  if (args[0] !== "--config") {
    throw new ConfigError(`Unknown argument: ${args[0]}`);
  }

  if (!args[1]) {
    throw new ConfigError("Missing value for --config");
  }

  if (args.length > 2) {
    throw new ConfigError(`Unknown argument: ${args[2]}`);
  }

  return args[1];
}

export async function loadConfig(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  const config = await loadProviderConfigFile(path, environment, false);
  if (config.providers.length === 0) {
    throw new ConfigError("providers must contain at least one provider");
  }
  return config;
}

export async function loadConfigLayers(
  workDir = process.cwd(),
  homeDirectory = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  const paths = [
    join(homeDirectory, ".QiCode", "config.yaml"),
    join(workDir, ".QiCode", "config.yaml"),
    join(workDir, ".QiCode", "config.local.yaml"),
  ];
  let merged: AppConfig = { providers: [], hooks: [] };
  let found = false;

  for (const path of new Set(paths)) {
    const layer = await loadProviderConfigFile(path, environment, true);
    if (layer === undefined) continue;
    found = true;
    merged = mergeConfig(merged, layer);
  }

  if (!found) {
    throw new ConfigError("No configuration file found in user or project directories");
  }
  if (merged.providers.length === 0) {
    throw new ConfigError("providers must contain at least one provider");
  }
  return merged;
}

function mergeConfig(base: AppConfig, override: AppConfig): AppConfig {
  return {
    providers: override.providers.length > 0
      ? override.providers.map(cloneProvider)
      : base.providers.map(cloneProvider),
    hooks: [...base.hooks, ...override.hooks],
  };
}

export async function loadMcpConfigLayers(
  workDir = process.cwd(),
  homeDirectory = homedir(),
): Promise<MCPConfig> {
  const paths = [
    join(homeDirectory, ".QiCode", "mcp-config", "config.yaml"),
    join(workDir, ".QiCode", "mcp-config", "config.yaml"),
    join(workDir, ".QiCode", "mcp-config", "config.local.yaml"),
  ];
  let merged: MCPConfig = { mcp_servers: [] };

  for (const path of new Set(paths)) {
    const layer = await loadMcpConfigFile(path, true);
    if (layer !== undefined) merged = mergeMcpConfig(merged, layer);
  }

  return merged;
}

async function loadProviderConfigFile(
  path: string,
  environment: NodeJS.ProcessEnv,
  optional: false,
): Promise<AppConfig>;
async function loadProviderConfigFile(
  path: string,
  environment: NodeJS.ProcessEnv,
  optional: true,
): Promise<AppConfig | undefined>;
async function loadProviderConfigFile(
  path: string,
  environment: NodeJS.ProcessEnv,
  optional: boolean,
): Promise<AppConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (optional && isMissingFileError(error)) return undefined;
    throw new ConfigError(`Cannot read configuration file: ${path}`, {
      cause: error,
    });
  }

  let document: unknown;
  try {
    document = loadYaml(contents);
  } catch {
    // YAML parser errors can contain source snippets, including API keys.
    throw new ConfigError(`Invalid YAML in configuration file: ${path}`);
  }

  const root = requireRecord(document, "configuration root");
  const rootFields = Object.keys(root);
  const unsupportedRootField = rootFields.find(
    (field) => field !== "providers" && field !== "hooks",
  );
  if (unsupportedRootField) {
    throw new ConfigError(`Unsupported configuration field: ${unsupportedRootField}`);
  }

  const names = new Set<string>();
  const providers = parseOptionalArray(root, "providers", "providers").map(
    (value, index) => {
      const provider = parseProvider(value, index, environment);
      if (names.has(provider.name)) {
        throw new ConfigError(`provider name must be unique: ${provider.name}`);
      }
      names.add(provider.name);
      return provider;
    },
  );

  const hooks = parseOptionalArray(root, "hooks", "hooks");
  return { providers, hooks };
}

async function loadMcpConfigFile(
  path: string,
  optional: boolean,
): Promise<MCPConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (optional && isMissingFileError(error)) return undefined;
    throw new ConfigError(`Cannot read MCP configuration file: ${path}`, {
      cause: error,
    });
  }

  let document: unknown;
  try {
    document = loadYaml(contents);
  } catch {
    throw new ConfigError(`Invalid YAML in MCP configuration file: ${path}`);
  }

  const root = requireRecord(document, "MCP configuration root");
  const unsupportedRootField = Object.keys(root).find(
    (field) => field !== "mcp_servers",
  );
  if (unsupportedRootField) {
    throw new ConfigError(`Unsupported MCP configuration field: ${unsupportedRootField}`);
  }
  return { mcp_servers: parseMcpServers(root) };
}

function parseMcpServers(root: Record<string, unknown>): MCPServerConfig[] {
  const names = new Set<string>();
  return parseOptionalArray(root, "mcp_servers", "mcp_servers").map(
    (value, index) => {
      const server = parseMcpServer(value, index);
      if (names.has(server.name)) {
        throw new ConfigError(`MCP server name must be unique: ${server.name}`);
      }
      names.add(server.name);
      return server;
    },
  );
}

function parseProvider(
  value: unknown,
  index: number,
  environment: NodeJS.ProcessEnv,
): ProviderConfig {
  const label = `providers[${index}]`;
  const provider = requireRecord(value, label);

  for (const field of Object.keys(provider)) {
    if (!PROVIDER_FIELDS.has(field)) {
      throw new ConfigError(`${label} has unsupported field: ${field}`);
    }
  }

  const name = requireString(provider, "name", label);
  const protocol = requireProtocol(provider.protocol, label);
  const model = requireString(provider, "model", label);
  const baseUrl = requireBaseUrl(provider, label);
  const apiKey = resolveApiKey(requireString(provider, "api_key", label), environment, label);
  const thinking = requireThinking(provider.thinking, protocol, label);

  return {
    name,
    protocol,
    model,
    base_url: baseUrl,
    api_key: apiKey,
    thinking,
  };
}

function parseMcpServer(value: unknown, index: number): MCPServerConfig {
  const label = `mcp_servers[${index}]`;
  const server = requireRecord(value, label);

  for (const field of Object.keys(server)) {
    if (!MCP_SERVER_FIELDS.has(field)) {
      throw new ConfigError(`${label} has unsupported field: ${field}`);
    }
  }

  return {
    name: requireString(server, "name", label),
    ...optionalStringProperty(server, "command", label),
    ...optionalStringArrayProperty(server, "args", label),
    ...optionalStringProperty(server, "url", label),
    ...optionalStringProperty(server, "transport", label),
    ...optionalStringRecordProperty(server, "headers", label),
    ...optionalStringRecordProperty(server, "env", label),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${label}.${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseOptionalArray(
  record: Record<string, unknown>,
  field: string,
  label: string,
): unknown[] {
  const value = record[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${label} must be an array`);
  }
  return value;
}

function optionalStringProperty<K extends string>(
  record: Record<string, unknown>,
  field: K,
  label: string,
): { [P in K]?: string } {
  const value = record[field];
  if (value === undefined) return {};
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${label}.${field} must be a non-empty string`);
  }
  return { [field]: value.trim() } as { [P in K]?: string };
}

function optionalStringArrayProperty<K extends string>(
  record: Record<string, unknown>,
  field: K,
  label: string,
): { [P in K]?: string[] } {
  const value = record[field];
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${label}.${field} must be an array of strings`);
  }
  return { [field]: [...value] } as { [P in K]?: string[] };
}

function optionalStringRecordProperty<K extends string>(
  record: Record<string, unknown>,
  field: K,
  label: string,
): { [P in K]?: Record<string, string> } {
  const value = record[field];
  if (value === undefined) return {};
  const entries = requireRecord(value, `${label}.${field}`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (typeof entry !== "string") {
      throw new ConfigError(`${label}.${field}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return { [field]: result } as { [P in K]?: Record<string, string> };
}

function requireProtocol(value: unknown, label: string): Protocol {
  if (value !== "anthropic" && value !== "openai") {
    throw new ConfigError(`${label}.protocol must be anthropic or openai`);
  }
  return value;
}

function requireBaseUrl(record: Record<string, unknown>, label: string): string {
  const value = requireString(record, "base_url", label);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported URL protocol");
    }
  } catch {
    throw new ConfigError(`${label}.base_url must be a valid HTTP or HTTPS URL`);
  }
  return value;
}

function resolveApiKey(
  value: string,
  environment: NodeJS.ProcessEnv,
  label: string,
): string {
  const match = ENV_REFERENCE.exec(value);
  if (!match) {
    return value;
  }

  const variableName = match[1]!;
  const resolved = environment[variableName];
  if (!resolved || resolved.trim() === "") {
    throw new ConfigError(
      `${label}.api_key environment variable ${variableName} is missing or empty`,
    );
  }
  return resolved;
}

function requireThinking(
  value: unknown,
  protocol: Protocol,
  label: string,
): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(`${label}.thinking must be a boolean`);
  }
  if (value && protocol !== "anthropic") {
    throw new ConfigError(
      `${label}.thinking=true is only supported for anthropic`,
    );
  }
  return value;
}

function mergeMcpServers(
  base: readonly MCPServerConfig[],
  override: readonly MCPServerConfig[],
): MCPServerConfig[] {
  const merged = base.map(cloneMcpServer);
  const indexes = new Map(merged.map((server, index) => [server.name, index]));

  for (const server of override) {
    const copy = cloneMcpServer(server);
    const index = indexes.get(server.name);
    if (index === undefined) {
      indexes.set(server.name, merged.length);
      merged.push(copy);
    } else {
      merged[index] = copy;
    }
  }
  return merged;
}

function mergeMcpConfig(base: MCPConfig, override: MCPConfig): MCPConfig {
  return { mcp_servers: mergeMcpServers(base.mcp_servers, override.mcp_servers) };
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  return { ...provider };
}

function cloneMcpServer(server: MCPServerConfig): MCPServerConfig {
  return {
    ...server,
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
    ...(server.env === undefined ? {} : { env: { ...server.env } }),
  };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
