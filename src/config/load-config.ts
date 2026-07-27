import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import type { AppConfig, Protocol, ProviderConfig } from "./types.js";

const PROVIDER_FIELDS = new Set([
  "name",
  "protocol",
  "model",
  "base_url",
  "api_key",
  "thinking",
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
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
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
  const unsupportedRootField = rootFields.find((field) => field !== "providers");
  if (unsupportedRootField) {
    throw new ConfigError(`Unsupported configuration field: ${unsupportedRootField}`);
  }

  if (!Array.isArray(root.providers) || root.providers.length === 0) {
    throw new ConfigError("providers must contain at least one provider");
  }

  const names = new Set<string>();
  const providers = root.providers.map((value, index) => {
    const provider = parseProvider(value, index, environment);
    if (names.has(provider.name)) {
      throw new ConfigError(`provider name must be unique: ${provider.name}`);
    }
    names.add(provider.name);
    return provider;
  });

  return { providers };
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
