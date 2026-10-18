import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFile, isMissing } from "../fs/atomic-write.js";
import { assertFileVersion, canonicalFilePath, contentHash, fileHash, withFileLocksSync } from "../fs/file-access.js";

export const MAX_SNAPSHOTS = 100;

export interface Backup {
  path: string;
  version: number;
  file: string | null;
  beforeHash: string | null;
  afterHash?: string | null;
}

export interface Snapshot {
  messageIndex: number;
  label: string;
  createdAt: string;
  backups: Record<string, Backup>;
}

/** Durable pre-edit backups. Restore is explicit and refuses subsequent user edits. */
export class FileHistory {
  private readonly sessionDir: string;
  private readonly indexPath: string;
  private readonly trackedFiles = new Map<string, number>();
  private readonly pendingBackups = new Map<string, Backup>();
  private snapshots: Snapshot[] = [];
  private indexHash: string | null = null;
  private pendingContext = { messageIndex: 0, label: "Recovered interrupted turn" };

  constructor(private readonly baseDir: string, sessionId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid file history session id");
    this.sessionDir = join(baseDir, ".QiCode", "file-history", sessionId);
    this.indexPath = join(this.sessionDir, "index.json");
    this.load();
  }

  static cleanupEmptySessionDirs(baseDir: string): number {
    const root = join(baseDir, ".QiCode", "file-history");
    if (!existsSync(root)) return 0;
    let removed = 0;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(root, entry.name);
        try { if (readdirSync(directory).length === 0) { rmdirSync(directory); removed += 1; } } catch { /* best effort */ }
      }
      if (readdirSync(root).length === 0) rmdirSync(root);
    } catch { /* best effort housekeeping */ }
    return removed;
  }

  beginTurn(messageIndex: number, label: string): void {
    if (this.pendingBackups.size > 0) this.makeSnapshot(this.pendingContext.messageIndex, this.pendingContext.label);
    this.pendingContext = { messageIndex, label: label.slice(0, 60) };
  }

  trackEdit(filePath: string, nextHash?: string): void {
    const path = canonicalFilePath(resolve(this.baseDir, filePath));
    this.assertProjectPath(path);
    assertFileVersion(this.indexPath, this.indexHash);
    const pending = this.pendingBackups.get(path);
    if (pending !== undefined) {
      const current = fileHash(path);
      if (pending.afterHash !== undefined && current !== pending.afterHash && current !== pending.beforeHash) {
        throw new Error("File changed after the previous agent edit; start a new turn to preserve those changes.");
      }
      if (nextHash !== undefined) pending.afterHash = nextHash;
      this.persist();
      return;
    }
    let version = (this.trackedFiles.get(path) ?? 0) + 1;
    // An interrupted index write can leave an unreferenced backup. Preserve it and use a new version.
    while (existsSync(this.backupPath(path, version))) version += 1;
    const beforeHash = fileHash(path);
    const file = beforeHash === null ? null : this.backupPath(path, version);
    mkdirSync(this.sessionDir, { recursive: true });
    if (file !== null) {
      const descriptor = openSync(file, "wx", 0o600);
      try {
        writeFileSync(descriptor, readFileSync(path));
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
    }
    this.trackedFiles.set(path, version);
    this.pendingBackups.set(path, { path, version, file, beforeHash, ...(nextHash === undefined ? {} : { afterHash: nextHash }) });
    // Must succeed before editing the source file.
    this.persist();
  }

  recordWrite(filePath: string): void {
    const path = canonicalFilePath(resolve(this.baseDir, filePath));
    const pending = this.pendingBackups.get(path);
    if (pending === undefined) throw new Error("Missing pre-edit backup");
    if (pending.afterHash !== undefined) assertFileVersion(path, pending.afterHash);
    else pending.afterHash = fileHash(path);
    this.persist();
  }

  makeSnapshot(messageIndex: number, userText: string): Snapshot {
    const backups: Record<string, Backup> = {};
    for (const [path, backup] of this.pendingBackups) {
      backups[path] = { ...backup, afterHash: backup.afterHash === undefined ? fileHash(path) : backup.afterHash };
    }
    const snapshot: Snapshot = { messageIndex, label: userText.slice(0, 60), createdAt: new Date().toISOString(), backups };
    this.snapshots = [...this.snapshots, snapshot].slice(-MAX_SNAPSHOTS);
    this.pendingBackups.clear();
    this.persist();
    return structuredClone(snapshot);
  }

  rewind(snapshotIndex: number): string[] {
    const paths = this.getSnapshots().slice(snapshotIndex).flatMap((snapshot) => Object.keys(snapshot.backups));
    return withFileLocksSync([this.indexPath, ...paths], () => this.rewindLocked(snapshotIndex));
  }

  private rewindLocked(snapshotIndex: number): string[] {
    const all = this.getSnapshots();
    if (!Number.isInteger(snapshotIndex) || snapshotIndex < 0 || snapshotIndex >= all.length) return [];
    const restore = new Map<string, { backup: Backup; expected: string | null | undefined }>();
    for (const snapshot of all.slice(snapshotIndex)) {
      for (const backup of Object.values(snapshot.backups)) {
        const prior = restore.get(backup.path);
        if (prior !== undefined && prior.expected !== backup.beforeHash) {
          throw new Error(`Cannot rewind across intervening edits to ${backup.path}; choose a more recent checkpoint.`);
        }
        restore.set(backup.path, { backup: prior?.backup ?? backup, expected: backup.afterHash });
      }
    }
    const prepared: Array<{ backup: Backup; bytes: Buffer | null; current: string | null }> = [];
    // Validate the entire restore before touching any source file.
    for (const { backup, expected } of restore.values()) {
      this.assertProjectPath(backup.path);
      const current = fileHash(backup.path);
      if (current !== backup.beforeHash && (expected === undefined || current !== expected)) {
        throw new Error(`Cannot rewind: ${backup.path} changed after the agent edit. Review and merge it first.`);
      }
      const bytes = backup.file === null ? null : readFileSync(backup.file);
      if ((bytes === null ? null : contentHash(bytes)) !== backup.beforeHash) throw new Error(`Cannot rewind: backup is damaged for ${backup.path}`);
      prepared.push({ backup, bytes, current });
    }
    assertFileVersion(this.indexPath, this.indexHash);
    const changed: string[] = [];
    for (const { backup, bytes, current } of prepared) {
      assertFileVersion(backup.path, current);
      if (current === backup.beforeHash) continue;
      if (bytes === null) unlinkSync(backup.path);
      else {
        mkdirSync(dirname(backup.path), { recursive: true });
        atomicWriteFile(backup.path, bytes, () => assertFileVersion(backup.path, current));
      }
      changed.push(backup.path);
    }
    this.snapshots = this.snapshots.slice(0, snapshotIndex);
    this.pendingBackups.clear();
    this.persistUnlocked();
    return changed;
  }

  getSnapshots(): Snapshot[] {
    const snapshots = structuredClone(this.snapshots);
    if (this.pendingBackups.size > 0) snapshots.push({
      ...this.pendingContext, createdAt: "", backups: Object.fromEntries(this.pendingBackups),
    });
    return structuredClone(snapshots);
  }

  hasSnapshots(): boolean { return this.snapshots.length > 0 || this.pendingBackups.size > 0; }
  hasPendingChanges(): boolean { return this.pendingBackups.size > 0; }

  private assertProjectPath(path: string): void {
    const rel = relative(canonicalFilePath(this.baseDir), canonicalFilePath(path));
    if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("File history path is outside the project");
  }

  private backupPath(path: string, version: number): string {
    const name = createHash("sha256").update(path).digest("hex").slice(0, 16);
    return join(this.sessionDir, `${name}@v${version}`);
  }

  private persist(): void {
    mkdirSync(this.sessionDir, { recursive: true });
    withFileLocksSync([this.indexPath], () => this.persistUnlocked());
  }

  private persistUnlocked(): void {
    assertFileVersion(this.indexPath, this.indexHash);
    const text = JSON.stringify({ version: 1, snapshots: this.snapshots, pending: [...this.pendingBackups.values()], tracked: [...this.trackedFiles], pendingContext: this.pendingContext });
    atomicWriteFile(this.indexPath, text);
    this.indexHash = contentHash(text);
  }

  private load(): void {
    let text: string;
    try { text = readFileSync(this.indexPath, "utf8"); } catch (error) { if (isMissing(error)) return; throw error; }
    const state: unknown = JSON.parse(text);
    if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.snapshots)
      || state.snapshots.length > MAX_SNAPSHOTS || !Array.isArray(state.pending) || !Array.isArray(state.tracked)) throw new Error("Invalid file history index; backups have been preserved");
    this.snapshots = state.snapshots.map((entry: unknown) => this.parseSnapshot(entry));
    for (const entry of state.pending) { const backup = this.parseBackup(entry); this.pendingBackups.set(backup.path, backup); }
    for (const entry of state.tracked) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Number.isSafeInteger(entry[1]) || entry[1] < 1) throw new Error("Invalid tracked file history entry");
      this.assertProjectPath(entry[0]);
      this.trackedFiles.set(entry[0], entry[1] as number);
    }
    if (isRecord(state.pendingContext) && Number.isSafeInteger(state.pendingContext.messageIndex)
      && Number(state.pendingContext.messageIndex) >= 0 && typeof state.pendingContext.label === "string") {
      this.pendingContext = { messageIndex: Number(state.pendingContext.messageIndex), label: state.pendingContext.label };
    }
    this.indexHash = contentHash(text);
  }

  private parseSnapshot(value: unknown): Snapshot {
    if (!isRecord(value) || !Number.isSafeInteger(value.messageIndex) || Number(value.messageIndex) < 0
      || typeof value.label !== "string" || typeof value.createdAt !== "string" || !isRecord(value.backups)) throw new Error("Invalid file history checkpoint");
    const backups: Record<string, Backup> = {};
    for (const entry of Object.values(value.backups)) { const backup = this.parseBackup(entry); backups[backup.path] = backup; }
    return { messageIndex: Number(value.messageIndex), label: value.label, createdAt: value.createdAt, backups };
  }

  private parseBackup(value: unknown): Backup {
    if (!isRecord(value) || typeof value.path !== "string" || !isAbsolute(value.path)
      || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || !validHash(value.beforeHash) || (value.afterHash !== undefined && !validHash(value.afterHash))
      || (value.file !== null && value.file !== this.backupPath(value.path, Number(value.version)))) throw new Error("Invalid file history backup");
    this.assertProjectPath(value.path);
    return value as unknown as Backup;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validHash(value: unknown): value is string | null { return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)); }
