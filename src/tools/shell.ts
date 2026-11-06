import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export interface ShellConfig { file: string; kind: "powershell" | "cmd" | "posix" }
export function resolveShell(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): ShellConfig {
  const configured = environment.QICODE_SHELL;
  const paths = (environment.PATH ?? environment.Path ?? "").split(platform === "win32" ? ";" : ":");
  function find(name: string): string | undefined {
    if (isAbsolute(name) && existsSync(name)) return name;
    return paths.map((path) => join(path, name)).find((path) => existsSync(path));
  }
  if (configured) {
    const file = find(configured) ?? (platform === "win32" ? find(`${configured}.exe`) : undefined);
    if (!file) throw new Error("QICODE_SHELL does not point to an available shell");
    const name = basename(file).toLowerCase();
    return { file, kind: /^(pwsh|powershell)(\.exe)?$/.test(name) ? "powershell" : /^cmd(\.exe)?$/.test(name) ? "cmd" : "posix" };
  }
  if (platform === "win32") {
    const pwsh = find("pwsh.exe");
    return pwsh ? { file: pwsh, kind: "powershell" } : { file: environment.COMSPEC ?? environment.ComSpec ?? "cmd.exe", kind: "cmd" };
  }
  const file = environment.SHELL;
  return { file: file && /\/(ba|z|k|da)?sh$/.test(file) && existsSync(file) ? file : "/bin/sh", kind: "posix" };
}

export function shellArgs(shell: ShellConfig, command: string): string[] {
  if (shell.kind === "cmd") return ["/d", "/s", "/c", `"${command}"`];
  if (shell.kind === "posix") return ["-c", command];
  const script = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; try { & {\n${command}\n}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
