import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isMissing } from "./atomic-write.js";

export function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Canonicalize aliases, including a new file under an existing symlinked parent. */
export function canonicalFilePath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = join(realpathSync.native(current), ...suffix);
      return canonical;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

export function fileHash(path: string): string | null {
  try { return contentHash(readFileSync(path)); } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function assertFileVersion(path: string, expected: string | null): void {
  if (fileHash(path) !== expected) {
    throw new Error("File changed since it was read; use ReadFile again and merge the latest changes.");
  }
}

function lockPathFor(path: string): string {
  const directory = join(tmpdir(), "qicode-file-locks");
  mkdirSync(directory, { recursive: true });
  const canonical = canonicalFilePath(path);
  return join(directory, `${contentHash(process.platform === "win32" ? canonical.toLowerCase() : canonical)}.lock`);
}

/** Synchronous restores fail fast when a writer is active instead of blocking the event loop. */
export function withFileLocksSync<T>(paths: readonly string[], action: () => T): T {
  const held: Array<{ path: string; token: string }> = [];
  try {
    for (const path of [...new Set(paths.map(lockPathFor))].sort()) {
      const token = randomUUID();
      let descriptor: number;
      try { descriptor = openSync(path, "wx", 0o600); } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        reclaimDeadLock(path);
        try { descriptor = openSync(path, "wx", 0o600); } catch {
          throw new Error("File is busy in another QiCode task; retry after it finishes.");
        }
      }
      held.push({ path, token });
      try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(descriptor); }
    }
    return action();
  } finally {
    for (const lock of held.reverse()) {
      try {
        const owner = JSON.parse(readFileSync(lock.path, "utf8")) as { token?: unknown };
        if (owner.token === lock.token) unlinkSync(lock.path);
      } catch (error) { if (!isMissing(error)) throw error; }
    }
  }
}

/** Advisory lock shared by QiCode processes; arbitrary editors and shells do not participate. */
export async function withFileLock<T>(path: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lockPath = lockPathFor(path);
  const token = randomUUID();
  const deadline = Date.now() + 5_000;
  while (true) {
    if (signal?.aborted) throw new Error("File operation cancelled");
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); }
      finally { closeSync(descriptor); }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      reclaimDeadLock(lockPath);
      if (Date.now() >= deadline) throw new Error("File is busy in another QiCode task; retry after it finishes.");
      await new Promise<void>((done) => setTimeout(done, 25));
    }
  }
  try {
    if (signal?.aborted) throw new Error("File operation cancelled");
    return await action();
  } finally {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (owner.token === token) unlinkSync(lockPath);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function reclaimDeadLock(lockPath: string): void {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; token?: unknown };
    if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
      if (Date.now() - statSync(lockPath).mtimeMs > 60_000) throw new Error(`Invalid stale file lock; inspect ${lockPath}`);
      return;
    }
    try { process.kill(owner.pid, 0); return; } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) return;
    }
    // Recheck the token under a reclamation guard before unlinking a dead owner's lock.
    const guardPath = `${lockPath}.reclaim`;
    let guard: number | undefined;
    try {
      guard = openSync(guardPath, "wx", 0o600);
      const latest = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; token?: unknown };
      if (latest.pid === owner.pid && latest.token === owner.token) unlinkSync(lockPath);
    } catch { /* A competing process may already be reclaiming it. */ }
    finally { if (guard !== undefined) { closeSync(guard); unlinkSync(guardPath); } }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid stale")) throw error;
  }
}
