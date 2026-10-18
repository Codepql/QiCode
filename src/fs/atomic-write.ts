import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Replace in the same directory, so a crash cannot leave a partially written target. */
export function atomicWriteFile(path: string, content: string | Uint8Array, beforeReplace?: () => void): void {
  let mode: number | undefined;
  try { mode = statSync(path).mode & 0o777; } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode ?? 0o666);
    // open applies umask even for an existing file's mode; restore those bits explicitly.
    if (mode !== undefined && process.platform !== "win32") fchmodSync(descriptor, mode);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    beforeReplace?.();
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (!isMissing(error)) throw error; }
  }
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
