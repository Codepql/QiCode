export type ToolCategory = "read" | "write" | "command";

export interface ToolResult {
  output: string;
  isError: boolean;
}

export interface ToolContext {
  workDir: string;
  abortSignal?: AbortSignal;
  readFiles?: Set<string>;
  /** 内部受控调用可追加环境变量，BashTool 始终保留当前进程环境。 */
  environment?: NodeJS.ProcessEnv;
  /** 比工具默认上限更严格的输出字节限制。 */
  maxOutputBytes?: number;
}

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  deferred?: boolean;
  system?: boolean;
  schema(): Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".qicode",
  ".QiCode",
  ".claude",
  "vendor",
  ".venv",
  "venv",
]);

export function strArg(
  args: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export function intArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

export function boolArg(
  args: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}
