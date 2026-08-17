import {
  lstatSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import type { PermissionMode } from "../permissions/checker.js";
import {
  cloneAgentDefinition,
  DEFAULT_SUBAGENT_MAX_TURNS,
  getBuiltinAgentDefinitions,
  isAgentName,
  MAX_SUBAGENT_MAX_TURNS,
  type AgentDefinition,
} from "./definition.js";

const AGENTS_DIRECTORY = ".QiCode";
const AGENT_FILE_PATTERN = /\.md$/i;
const AGENT_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "disallowed_tools",
  "system_prompt",
  "max_turns",
  "model",
  "permission_mode",
  "background",
  "isolation",
  "initial_prompt",
  "skills",
  "mcp_servers",
]);

export interface AgentDefinitionDiagnostic {
  filePath: string;
  message: string;
}

export interface AgentDefinitionLoadResult {
  definitions: AgentDefinition[];
  diagnostics: AgentDefinitionDiagnostic[];
}

/**
 * 合并内置、用户级、项目级角色。后加载的同名合法定义覆盖前一个；
 * 损坏文件只记录诊断，绝不删除已存在的同名角色。
 */
export function loadAgentDefinitions(
  workDir: string,
  homeDirectory = homedir(),
): AgentDefinitionLoadResult {
  const definitions = new Map(
    getBuiltinAgentDefinitions().map((definition) => [definition.name, definition]),
  );
  const diagnostics: AgentDefinitionDiagnostic[] = [];

  for (const directory of [
    join(homeDirectory, AGENTS_DIRECTORY, "agents"),
    join(workDir, AGENTS_DIRECTORY, "agents"),
  ]) {
    scanAgentDirectory(directory, definitions, diagnostics);
  }

  return {
    definitions: [...definitions.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(cloneAgentDefinition),
    diagnostics,
  };
}

export function parseAgentDefinitionFile(content: string): AgentDefinition | null {
  const opening = content.match(/^---\r?\n/);
  if (opening === null) return null;

  const closing = /\r?\n---(?:\r?\n|$)/.exec(content.slice(opening[0].length));
  if (closing === null || closing.index === undefined) return null;

  let raw: unknown;
  try {
    raw = parseYaml(content.slice(opening[0].length, opening[0].length + closing.index));
  } catch {
    return null;
  }
  if (!isRecord(raw) || Object.keys(raw).some((field) => !AGENT_FIELDS.has(field))) {
    return null;
  }

  const name = requiredString(raw, "name");
  if (name === null || !isAgentName(name)) return null;
  const description = optionalString(raw, "description");
  const tools = optionalStringArray(raw, "tools");
  const disallowedTools = optionalStringArray(raw, "disallowed_tools");
  const systemPrompt = optionalString(raw, "system_prompt");
  const maxTurns = optionalMaxTurns(raw.max_turns);
  const model = optionalString(raw, "model");
  const permissionMode = optionalPermissionMode(raw.permission_mode);
  const background = optionalBoolean(raw, "background");
  const isolation = optionalIsolation(raw.isolation);
  const initialPrompt = optionalString(raw, "initial_prompt");
  const skills = optionalStringArray(raw, "skills");
  const mcpServers = optionalStringArray(raw, "mcp_servers");

  if (
    description === null || tools === null || disallowedTools === null || systemPrompt === null
    || maxTurns === null || model === null || permissionMode === null || background === null
    || isolation === null || initialPrompt === null || skills === null || mcpServers === null
  ) return null;

  const bodyStart = opening[0].length + closing.index + closing[0].length;
  const body = content.slice(bodyStart).trim();
  return {
    name,
    description: description ?? "",
    maxTurns: maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
    permissionMode: permissionMode ?? "default",
    background: background ?? false,
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(systemPrompt === undefined && body === "" ? {} : { systemPromptOverride: systemPrompt ?? body }),
    ...(model === undefined ? {} : { model }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
    ...(skills === undefined ? {} : { skills }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

function scanAgentDirectory(
  directory: string,
  definitions: Map<string, AgentDefinition>,
  diagnostics: AgentDefinitionDiagnostic[],
): void {
  let children: Dirent[];
  try {
    children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return;
  }

  for (const child of children) {
    if (!child.isFile() || child.isSymbolicLink() || !AGENT_FILE_PATTERN.test(child.name)) continue;
    const filePath = join(directory, child.name);
    try {
      if (!lstatSync(filePath).isFile()) continue;
      const definition = parseAgentDefinitionFile(readFileSync(filePath, "utf8"));
      if (definition === null) {
        diagnostics.push({ filePath, message: "invalid Agent definition frontmatter" });
        continue;
      }
      definitions.set(definition.name, definition);
    } catch {
      diagnostics.push({ filePath, message: "unable to read Agent definition" });
    }
  }
}

function requiredString(record: Record<string, unknown>, field: string): string | null {
  const value = optionalString(record, field);
  return value === undefined ? null : value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined | null {
  const value = record[field];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalStringArray(
  record: Record<string, unknown>,
  field: string,
): string[] | undefined | null {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const values = value.map((entry) => typeof entry === "string" ? entry.trim() : "");
  if (values.some((entry) => entry === "")) return null;
  return [...new Set(values)];
}

function optionalMaxTurns(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_SUBAGENT_MAX_TURNS
    ? value
    : null;
}

function optionalPermissionMode(value: unknown): PermissionMode | undefined | null {
  if (value === undefined) return undefined;
  return value === "default" || value === "acceptEdits" || value === "plan" || value === "bypassPermissions"
    ? value
    : null;
}

function optionalBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean | undefined | null {
  const value = record[field];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function optionalIsolation(value: unknown): "worktree" | undefined | null {
  if (value === undefined) return undefined;
  return value === "worktree" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
