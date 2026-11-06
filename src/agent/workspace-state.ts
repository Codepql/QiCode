import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Fingerprints only; never persist git diff bodies or existing file contents. */
export async function workspaceState(workDir: string): Promise<Map<string, string> | undefined> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], { cwd: workDir, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 5000, windowsHide: true });
    const paths = stdout.split("\0"); const state = new Map<string, string>();
    for (let i = 0; i < paths.length; i++) {
      const entry = paths[i]!; if (!entry) continue;
      if (entry[0] === "R" || entry[0] === "C") i++;
      const target = resolve(workDir, entry.slice(3));
      if (target !== resolve(workDir) && !target.startsWith(resolve(workDir) + sep)) continue;
      let fingerprint = entry.slice(0, 2);
      try {
        const info = await lstat(target);
        if (info.isFile() && !info.isSymbolicLink()) fingerprint += info.size <= 16 * 1024 * 1024 ? createHash("sha256").update(await readFile(target)).digest("hex") : `${info.size}:${info.mtimeMs}`;
      } catch { fingerprint += ":missing"; }
      state.set(target, fingerprint);
    }
    return state;
  } catch { return undefined; }
}
