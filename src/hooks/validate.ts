import type {
  HookAction,
  HookActionType,
  HookDiagnostic,
  HookErrorPolicy,
  HookEvent,
  HookRule,
  HookValidationResult,
} from "./types.js";
import { HOOK_EVENTS } from "./types.js";

const ACTION_TYPES = new Set<HookActionType>(["command", "prompt", "http", "agent"]);
const ERROR_POLICIES = new Set<HookErrorPolicy>(["ignore", "fail", "reject"]);
const MAX_CONDITION_LENGTH = 512;

/**
 * 将配置层保留的原始 Hook 逐条校验。坏规则只生成诊断，不影响其它规则。
 */
export function validateHooks(inputs: readonly unknown[]): HookValidationResult {
  const hooks: HookRule[] = [];
  const diagnostics: HookDiagnostic[] = [];

  for (const [index, input] of inputs.entries()) {
    const result = validateHook(input, index);
    if ("hook" in result) hooks.push(result.hook);
    else diagnostics.push(result.diagnostic);
  }
  return { hooks, diagnostics };
}

function validateHook(
  input: unknown,
  index: number,
): { hook: HookRule } | { diagnostic: HookDiagnostic } {
  if (!isRecord(input)) return invalid(index, undefined, "hook must be an object");

  const id = optionalNonEmptyString(input, "id");
  if (id === null) return invalid(index, undefined, "id must be a non-empty string");

  const event = requiredEvent(input.event);
  if (event === null) return invalid(index, id, eventMessage(input.event));

  const condition = optionalString(input, "condition");
  if (condition === null) return invalid(index, id, "condition must be a string");
  if (condition !== undefined && condition.length > MAX_CONDITION_LENGTH) {
    return invalid(index, id, `condition exceeds ${MAX_CONDITION_LENGTH} characters`);
  }

  const action = validateAction(input.action);
  if (action === null) return invalid(index, id, actionMessage(input.action));

  const reject = optionalBoolean(input, "reject");
  const once = optionalBoolean(input, "once");
  const asyncAction = optionalBoolean(input, "async");
  if (reject === null || once === null || asyncAction === null) {
    return invalid(index, id, "reject, once, and async must be booleans");
  }
  if (reject === true && event !== "pre_tool_use") {
    return invalid(index, id, "reject is only valid for pre_tool_use");
  }
  if (reject === true && asyncAction === true) {
    return invalid(index, id, "reject and async are mutually exclusive");
  }

  const onError = optionalErrorPolicy(input.on_error);
  if (onError === null) return invalid(index, id, "on_error must be ignore, fail, or reject");

  return {
    hook: {
      ...(id === undefined ? {} : { id }),
      event,
      ...(condition === undefined ? {} : { condition }),
      action,
      reject: reject ?? false,
      once: once ?? false,
      async: asyncAction ?? false,
      onError: onError ?? "ignore",
    },
  };
}

function validateAction(value: unknown): HookAction | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (!ACTION_TYPES.has(value.type as HookActionType)) return null;

  const type = value.type as HookActionType;
  const command = optionalString(value, "command");
  const prompt = optionalString(value, "prompt");
  const url = optionalString(value, "url");
  const method = optionalString(value, "method");
  if (command === null || prompt === null || url === null || method === null) return null;

  if (type === "command" && command === undefined) return null;
  if (type === "prompt" && prompt === undefined) return null;
  if (type === "http" && url === undefined) return null;
  if (type === "agent" && command === undefined && prompt === undefined) return null;

  return {
    type,
    ...(command === undefined ? {} : { command }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(url === undefined ? {} : { url }),
    ...(method === undefined ? {} : { method: method.toUpperCase() }),
  };
}

function actionMessage(value: unknown): string {
  if (!isRecord(value)) return "action must be an object";
  if (typeof value.type !== "string" || value.type.trim() === "") return "action.type is required";
  if (!ACTION_TYPES.has(value.type as HookActionType)) return `invalid action.type '${value.type}'`;
  if (value.type === "command") return "command action requires action.command";
  if (value.type === "prompt") return "prompt action requires action.prompt";
  if (value.type === "http") return "http action requires action.url";
  return "agent action requires action.command or action.prompt";
}

function requiredEvent(value: unknown): HookEvent | null {
  return typeof value === "string" && HOOK_EVENTS.includes(value as HookEvent)
    ? value as HookEvent
    : null;
}

function eventMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "event is required";
  return `invalid event '${value}'`;
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string): string | undefined | null {
  if (record[key] === undefined) return undefined;
  return optionalString(record, key);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function optionalErrorPolicy(value: unknown): HookErrorPolicy | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && ERROR_POLICIES.has(value as HookErrorPolicy)
    ? value as HookErrorPolicy
    : null;
}

function invalid(index: number, id: string | undefined, message: string): { diagnostic: HookDiagnostic } {
  return { diagnostic: { index, ...(id === undefined ? {} : { id }), message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
