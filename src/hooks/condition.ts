import { matchesGlob } from "node:path";
import type { HookContext } from "./types.js";

const MAX_CONDITION_LENGTH = 512;
const MAX_REGEX_LENGTH = 256;
const ATOM_PATTERN = /^\s*(!)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|=~|=\*)\s*(.*?)\s*$/;

/**
 * 求值一行 Hook 条件。&& 与 || 按从左到右结合，故意不支持括号。
 * 配置损坏、非法正则或无效 glob 全部视为不匹配，不能中断 Agent。
 */
export function evaluateCondition(condition: string | undefined, context: HookContext): boolean {
  if (condition === undefined || condition.trim() === "") return true;
  if (condition.length > MAX_CONDITION_LENGTH) return false;

  const parts = condition.trim().split(/\s+(&&|\|\|)\s+/);
  if (parts.length === 0 || parts[0] === undefined) return false;

  let result = evaluateAtom(parts[0], context);
  for (let index = 1; index < parts.length; index += 2) {
    const operator = parts[index];
    const atom = parts[index + 1];
    if ((operator !== "&&" && operator !== "||") || atom === undefined) return false;

    const next = evaluateAtom(atom, context);
    result = operator === "&&" ? result && next : result || next;
  }
  return result;
}

function evaluateAtom(source: string, context: HookContext): boolean {
  const match = ATOM_PATTERN.exec(source);
  if (match === null) return false;

  const inverted = match[1] === "!";
  const field = match[2]!;
  const operator = match[3]!;
  const expected = parseLiteral(match[4] ?? "");
  const actual = contextValue(field, context);

  let matched: boolean;
  switch (operator) {
    case "==":
      matched = actual === expected;
      break;
    case "!=":
      matched = actual !== expected;
      break;
    case "=~":
      matched = regexMatches(actual, expected);
      break;
    case "=*":
      matched = globMatches(actual, expected);
      break;
    default:
      return false;
  }
  return inverted ? !matched : matched;
}

function parseLiteral(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.at(0);
  if ((quote === "\"" || quote === "'") && trimmed.at(-1) === quote && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function contextValue(field: string, context: HookContext): string {
  switch (field) {
    case "event":
      return context.event;
    case "tool":
    case "tool_name":
      return context.toolName ?? "";
    case "file_path":
      return context.filePath ?? "";
    case "message":
      return context.message ?? "";
    default:
      return stringifyArgument(context.args?.[field]);
  }
}

function stringifyArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function regexMatches(value: string, source: string): boolean {
  if (source.length > MAX_REGEX_LENGTH) return false;
  try {
    return new RegExp(source).test(value);
  } catch {
    return false;
  }
}

function globMatches(value: string, pattern: string): boolean {
  try {
    return matchesGlob(normalizePath(value), normalizePath(pattern));
  } catch {
    return false;
  }
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}
