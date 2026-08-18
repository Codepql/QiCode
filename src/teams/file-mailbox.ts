import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const LOCK_MAX_ATTEMPTS = 10;
export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MIN_MS = 5;
export const LOCK_RETRY_MAX_MS = 100;

const MAILBOX_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface FileMailMessage {
  from: string;
  text: string;
  timestamp: string;
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

/**
 * A per-member append-only JSONL mailbox. The cursor is intentionally stored
 * separately so a member can restart without re-consuming old messages.
 */
export class FileMailbox {
  readonly #filePath: string;
  readonly #readStatePath: string;
  #lastReadLines: number;

  constructor(directory: string, memberName: string) {
    if (!MAILBOX_NAME_PATTERN.test(memberName)) {
      throw new Error("mailbox member name must contain only alphanumeric characters, hyphen, and underscore");
    }
    mkdirSync(directory, { recursive: true });
    this.#filePath = join(directory, `${memberName}.jsonl`);
    this.#readStatePath = join(directory, `${memberName}.read`);
    this.#lastReadLines = this.loadReadState();
  }

  async send(from: string, text: string): Promise<void> {
    const message: FileMailMessage = {
      from: from.trim(),
      text,
      timestamp: new Date().toISOString(),
    };
    await withLock(this.#filePath, () => {
      writeFileSync(this.#filePath, `${JSON.stringify(message)}\n`, { encoding: "utf8", flag: "a" });
    });
  }

  /**
   * Synchronous consumers must not block the event loop while another process
   * owns the mailbox. Returning an empty batch is safe because the cursor is
   * unchanged and the next poll will retry.
   */
  receiveSync(): FileMailMessage[] {
    const owner = tryAcquireLock(lockPathFor(this.#filePath));
    if (owner === undefined) return [];
    try {
      return this.consumeUnreadMessages();
    } finally {
      releaseLock(lockPathFor(this.#filePath), owner);
    }
  }

  async receive(): Promise<FileMailMessage[]> {
    return withLock(this.#filePath, () => this.consumeUnreadMessages());
  }

  unreadCount(): number {
    return Math.max(0, this.allLines().length - this.#lastReadLines);
  }

  markAllRead(): void {
    const owner = tryAcquireLock(lockPathFor(this.#filePath));
    if (owner === undefined) return;
    try {
      this.#lastReadLines = this.allLines().length;
      this.saveReadState();
    } finally {
      releaseLock(lockPathFor(this.#filePath), owner);
    }
  }

  async *poll(intervalMs = 1_000): AsyncGenerator<FileMailMessage> {
    const delayMs = positiveInterval(intervalMs);
    while (true) {
      const messages = await this.receive();
      for (const message of messages) yield message;
      await delay(delayMs);
    }
  }

  private consumeUnreadMessages(): FileMailMessage[] {
    const lines = this.allLines();
    const unreadLines = lines.slice(this.#lastReadLines);
    this.#lastReadLines = lines.length;
    this.saveReadState();
    return unreadLines.flatMap(parseMessage);
  }

  private loadReadState(): number {
    try {
      const value = Number.parseInt(readFileSync(this.#readStatePath, "utf8").trim(), 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  private saveReadState(): void {
    try {
      writeFileSync(this.#readStatePath, String(this.#lastReadLines), "utf8");
    } catch {
      // Cursor persistence is best effort. The next process may re-read data,
      // but it must never lose unread messages because of an I/O failure.
    }
  }

  private allLines(): string[] {
    if (!existsSync(this.#filePath)) return [];
    try {
      return readFileSync(this.#filePath, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }
}

async function withLock<T>(filePath: string, fn: () => T): Promise<T> {
  const lockPath = lockPathFor(filePath);
  const owner = await acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, owner);
  }
}

async function acquireLock(lockPath: string): Promise<LockOwner> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    const owner = tryAcquireLock(lockPath);
    if (owner !== undefined) return owner;
    lastError = new Error(`mailbox lock is busy: ${lockPath}`);
    await delay(randomRetryDelay());
  }
  throw lastError ?? new Error(`could not acquire mailbox lock: ${lockPath}`);
}

function tryAcquireLock(lockPath: string): LockOwner | undefined {
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
  try {
    const descriptor = openSync(lockPath, "wx");
    try {
      writeFileSync(descriptor, JSON.stringify(owner), "utf8");
    } finally {
      closeSync(descriptor);
    }
    return owner;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  reclaimStaleLock(lockPath);
  return undefined;
}

function reclaimStaleLock(lockPath: string): void {
  const observed = readLockOwner(lockPath);
  if (observed === undefined || !isStaleLock(lockPath, observed) || isProcessAlive(observed.pid)) return;

  const claimedPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    // rename is atomic: another contender either sees the old lock or its absence.
    renameSync(lockPath, claimedPath);
    const claimedOwner = readLockOwner(claimedPath);
    if (claimedOwner?.token === observed.token) unlinkSync(claimedPath);
    else if (existsSync(claimedPath)) renameSync(claimedPath, lockPath);
  } catch {
    // A competing owner may have acquired or released the lock. Retry normally.
  }
}

function releaseLock(lockPath: string, owner: LockOwner): void {
  try {
    if (readLockOwner(lockPath)?.token === owner.token) unlinkSync(lockPath);
  } catch {
    // A stale lock is safer than deleting another owner's lock.
  }
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (!isRecord(value)) return undefined;
    const token = value.token;
    const pid = value.pid;
    const createdAt = value.createdAt;
    return typeof token === "string"
      && typeof pid === "number"
      && Number.isSafeInteger(pid)
      && typeof createdAt === "number"
      ? { token, pid, createdAt }
      : undefined;
  } catch {
    return undefined;
  }
}

function isStaleLock(lockPath: string, owner: LockOwner): boolean {
  try {
    return Date.now() - Math.max(owner.createdAt, statSync(lockPath).mtimeMs) > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function parseMessage(line: string): FileMailMessage[] {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) return [];
    return typeof value.from === "string"
      && typeof value.text === "string"
      && typeof value.timestamp === "string"
      ? [{ from: value.from, text: value.text, timestamp: value.timestamp }]
      : [];
  } catch {
    return [];
  }
}

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

function randomRetryDelay(): number {
  return LOCK_RETRY_MIN_MS + Math.floor(
    Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1),
  );
}

function positiveInterval(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
