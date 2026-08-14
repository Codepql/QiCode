import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { load as parseYaml } from "js-yaml";
import type { Command } from "./commands.js";

const COMMANDS_DIRECTORY = ".QiCode";

export function loadUserCommands(workDir: string): Command[] {
  const byName = new Map<string, Command>();
  const roots = [
    join(homedir(), COMMANDS_DIRECTORY, "commands"),
    join(workDir, COMMANDS_DIRECTORY, "commands"),
  ];

  for (const root of roots) {
    for (const command of walkDirectory(root, root)) {
      byName.set(command.name, command);
    }
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function renderBody(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  if (args !== "") return `${body}\n\n${args}`;
  return body;
}

function walkDirectory(base: string, directory: string): Command[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }

  const commands: Command[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    try {
      // Symlinks are ignored so a command directory cannot expose files outside its root.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        commands.push(...walkDirectory(base, fullPath));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const command = parseCommandFile(base, fullPath);
        if (command) commands.push(command);
      }
    } catch {
      // A single bad entry must not prevent other commands from loading.
    }
  }
  return commands;
}

function parseCommandFile(base: string, filePath: string): Command | null {
  let content: string;
  try {
    if (lstatSync(filePath).isSymbolicLink()) return null;
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const name = commandName(base, filePath);
  const parsed = parseDocument(content);
  return {
    name,
    aliases: parsed.aliases,
    type: "prompt",
    description: parsed.description ?? `Run ${name}`,
    ...(parsed.argumentHint === undefined ? {} : { argumentHint: parsed.argumentHint }),
    handler: (context) => renderBody(parsed.body, context.args),
  };
}

function commandName(base: string, filePath: string): string {
  const relativePath = relative(base, filePath);
  const withoutExtension = relativePath.replace(/\.md$/i, "");
  return withoutExtension
    .split(/[\\/]/)
    .map((segment) => segment.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter((segment) => segment !== "")
    .join(":");
}

interface ParsedDocument {
  body: string;
  description?: string;
  argumentHint?: string;
  aliases: string[];
}

function parseDocument(content: string): ParsedDocument {
  const fallback: ParsedDocument = { body: content, aliases: [] };
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return fallback;

  const closing = /\r?\n---(?:\r?\n|$)/.exec(content);
  if (!closing || closing.index === undefined) return fallback;

  const header = content.slice(4, closing.index);
  const bodyStart = closing.index + closing[0].length;
  try {
    const metadata = parseYaml(header);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return { ...fallback, body: content.slice(bodyStart) };
    }

    const record = metadata as Record<string, unknown>;
    const description = stringValue(record.description);
    const argumentHint = stringValue(record["argument-hint"]);
    return {
      body: content.slice(bodyStart),
      aliases: aliasesValue(record.aliases),
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint }),
    };
  } catch {
    return fallback;
  }
}

function aliasesValue(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item, index, all) => item !== "" && all.indexOf(item) === index);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
