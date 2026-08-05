import { spawn, spawnSync } from "node:child_process";
import { BashDescription } from "./descriptions.js";
import { intArg, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

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
        },
        required: ["command"],
      },
    };
  }

  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = strArg(args, "command");
    if (!command) return Promise.resolve({ output: "错误：command 是必填项", isError: true });

    const requestedTimeout = intArg(args, "timeout", 120);
    const timeoutSeconds = Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_SECONDS);
    const shell = process.platform === "win32"
      ? (process.env["COMSPEC"] ?? "cmd.exe")
      : "/bin/sh";

    return new Promise((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let aborted = false;
      let outputTooLarge = false;
      let settled = false;

      const child = spawn(command, {
        cwd: ctx.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        shell,
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ctx.abortSignal?.removeEventListener("abort", abort);
        resolve(result);
      };

      const terminate = (): void => {
        if (child.killed || child.pid === undefined) return;
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          return;
        }
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      };

      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          outputTooLarge = true;
          terminate();
          return;
        }
        if (target === "stdout") stdoutChunks.push(chunk);
        else stderrChunks.push(chunk);
      };

      const abort = (): void => {
        aborted = true;
        terminate();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
        // Do not keep the chat waiting if Windows cannot immediately reap a child process.
        finish({ output: `错误：命令执行超过 ${timeoutSeconds} 秒`, isError: true });
      }, timeoutSeconds * 1000);

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", (error) => {
        finish({ output: `错误：启动命令失败：${error.message}`, isError: true });
      });
      child.once("close", (exitCode, signal) => {
        if (timedOut) {
          finish({ output: `错误：命令执行超过 ${timeoutSeconds} 秒`, isError: true });
          return;
        }
        if (aborted) {
          finish({ output: "错误：命令已取消", isError: true });
          return;
        }
        if (outputTooLarge) {
          finish({ output: "错误：命令输出超过 10 MB 上限", isError: true });
          return;
        }
        if (exitCode === null) {
          finish({ output: `错误：命令被信号 ${signal ?? "unknown"} 终止`, isError: true });
          return;
        }

        const stdout = decodeChildOutput(Buffer.concat(stdoutChunks));
        const stderr = decodeChildOutput(Buffer.concat(stderrChunks));
        const output = [
          `$ ${command}`,
          stdout,
          stderr ? `标准错误：${stderr}` : "",
          `退出码：${exitCode}`,
        ].filter(Boolean).join("\n");
        finish({ output, isError: interpretExitCode(command, exitCode) });
      });

      if (ctx.abortSignal?.aborted) abort();
      else ctx.abortSignal?.addEventListener("abort", abort, { once: true });
    });
  }
}
