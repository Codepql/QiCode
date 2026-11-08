import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { prepareSafeCommand } from "../permissions/checker.js";
import { join } from "node:path";
import { resolveShell, shellArgs } from "./shell.js";
import { BashDescription } from "./descriptions.js";
import { intArg, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const MAX_TIMEOUT_SECONDS = 600;

// Windows 控制台代码页 -> TextDecoder 标签（中文系统常见 936/GBK）。
const CODEPAGE_LABELS: Record<number, string> = {
  437: "ibm437",
  850: "ibm850",
  852: "ibm852",
  866: "ibm866",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  65001: "utf-8",
};

let outputEncodingLabel: string | undefined;

function detectOutputEncodingLabel(): string {
  if (outputEncodingLabel !== undefined) return outputEncodingLabel;
  let label = "utf-8";
  if (process.platform === "win32") {
    try {
      const result = spawnSync("chcp", [], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        encoding: "utf8",
      });
      const match = /(\d+)/.exec(result.stdout ?? "");
      if (match !== null) label = CODEPAGE_LABELS[Number(match[1])] ?? "utf-8";
    } catch {
      // 检测失败时保持 utf-8
    }
  }
  outputEncodingLabel = label;
  return label;
}

/**
 * 解码子进程输出：优先按 UTF-8 解码，若出现替换符（U+FFFD）则回退到
 * Windows 控制台代码页（如 GBK），解决中文 Windows 下 cmd/PowerShell 输出乱码。
 */
export function decodeChildOutput(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("\uFFFD")) return utf8;
  return new TextDecoder(detectOutputEncodingLabel()).decode(bytes);
}

const NON_ERROR_EXIT_THRESHOLDS = new Map([
  ["grep", 2],
  ["egrep", 2],
  ["fgrep", 2],
  ["rg", 2],
  ["diff", 2],
  ["test", 2],
  ["[", 2],
  ["find", 2],
]);

export function interpretExitCode(command: string, exitCode: number): boolean {
  const lastCommand = command.split("|").pop()?.trim() ?? command.trim();
  const tokens = lastCommand.split(/\s+/).filter(Boolean);
  const commandNames = tokens
    .filter((token) => !token.includes("=") && !token.startsWith("-"))
    .map((token) => token.split(/[\\/]/).pop()?.toLowerCase());
  const name = [...commandNames].reverse().find((candidate) =>
    candidate !== undefined && NON_ERROR_EXIT_THRESHOLDS.has(candidate),
  );
  const threshold = name ? NON_ERROR_EXIT_THRESHOLDS.get(name) : undefined;
  return threshold === undefined ? exitCode !== 0 : exitCode >= threshold;
}

export class BashTool implements Tool {
  readonly name = "Bash";
  readonly description = BashDescription;
  readonly category = "command" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 Shell 命令" },
          timeout: { type: "integer", default: 120, description: "超时时间，单位为秒" },
          purpose: { type: "string", enum: ["verification", "task"], description: "验证测试/构建时填写 verification，用于记录真实验证结果" },
        },
        required: ["command"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = strArg(args, "command");
    if (!command) return { output: "错误：command 是必填项", isError: true };
    if (ctx.abortSignal?.aborted) return { output: "错误：命令已取消，未执行", isError: true, metadata: { status: "cancelled" } };
    const timeoutSeconds = Math.min(Math.max(intArg(args, "timeout", ctx.commandTimeoutSeconds ?? 120), 1), ctx.maxCommandTimeoutSeconds ?? MAX_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
    const previewLimit = Math.max(1, Math.min(ctx.maxOutputBytes ?? 64_000, 64_000));
    const logLimit = Math.max(1, ctx.maxOutputBytes ?? ctx.maxLogBytes ?? 100 * 1024 * 1024);
    const shell = resolveShell();
    const directory = join(ctx.workDir, ".qicode", "tool_results");
    mkdirSync(directory, { recursive: true });
    const logPath = join(directory, `command-${randomUUID()}.log`);
    const fd = openSync(logPath, "wx", 0o600);
    return new Promise((resolve) => {
      const started = Date.now();
      let bytes = 0;
      let tail = Buffer.alloc(0);
      let settled = false;
      let status: "completed" | "failed" | "cancelled" | "timeout" = "completed";
      let problem = "";
      let quotaExceeded = false;
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const child = spawn(shell.file, shellArgs(shell, prepareSafeCommand(command) ?? command), {
        cwd: ctx.workDir, stdio: ["ignore", "pipe", "pipe"], shell: false,
        env: { ...process.env, ...ctx.environment }, detached: process.platform !== "win32",
        windowsHide: true, windowsVerbatimArguments: shell.kind === "cmd",
      });
      const preview = (): string => decodeChildOutput(tail);
      const notify = (): void => { updateTimer = undefined; ctx.onUpdate?.(preview()); };
      const finish = (exitCode: number | null, confirmed = true): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(updateTimer);
        clearTimeout(killTimer);
        ctx.abortSignal?.removeEventListener("abort", abort);
        closeSync(fd);
        const truncated = bytes > tail.length;
        const output = [
          `$ ${command}`, preview(), problem,
          exitCode === null ? "" : `退出码：${exitCode}`,
          truncated ? `[输出预览已截断，完整日志：${logPath}]` : `日志：${logPath}`,
          !confirmed ? "子进程退出尚未确认；请核对进程状态，不要盲目重放命令。" : "",
        ].filter(Boolean).join("\n");
        resolve({ output, isError: status !== "completed" || exitCode === null || interpretExitCode(command, exitCode),
          metadata: { status: status === "completed" && (exitCode === null || interpretExitCode(command, exitCode)) ? "failed" : status,
            exitCode, elapsed: (Date.now() - started) / 1000, cwd: ctx.workDir, logPath, truncated } });
      };
      const terminate = (): void => {
        if (child.pid === undefined) { finish(null); return; }
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => child.kill());
        } else {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        }
        killTimer ??= setTimeout(() => {
          if (process.platform !== "win32" && child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          }
          finish(null, false);
        }, 2500);
      };
      const append = (chunk: Buffer): void => {
        if (settled) return;
        const remaining = Math.max(0, logLimit - bytes);
        const kept = chunk.subarray(0, remaining);
        try { if (kept.length) writeSync(fd, kept); }
        catch { status = "failed"; problem = "错误：命令日志写入失败"; terminate(); return; }
        bytes += kept.length;
        tail = Buffer.concat([tail, kept]).subarray(-previewLimit);
        if (shell.kind === "powershell") {
          let start = 0;
          while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
          tail = tail.subarray(start);
        }
        if (ctx.onUpdate && !updateTimer) updateTimer = setTimeout(notify, 80);
        if (kept.length < chunk.length && !quotaExceeded) {
          quotaExceeded = true; status = "failed";
          problem = `错误：命令日志超过 ${formatByteLimit(logLimit)} 上限，日志不完整`;
          terminate();
        }
      };
      const abort = (): void => { status = "cancelled"; problem = "错误：命令已取消"; terminate(); };
      const timeout = setTimeout(() => {
        status = "timeout"; problem = `错误：命令执行超过 ${timeoutSeconds} 秒`; terminate();
      }, timeoutSeconds * 1000);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", (error) => { status = "failed"; problem = `错误：启动命令失败：${error.message}`; finish(null); });
      child.once("close", (exitCode, signal) => {
        if (signal && !problem) problem = `命令被信号 ${signal} 终止`;
        finish(exitCode);
      });
      if (ctx.abortSignal?.aborted) abort();
      else ctx.abortSignal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function formatByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}
