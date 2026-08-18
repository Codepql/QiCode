import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_SNAPSHOTS = 100;

export interface Backup {
  path: string;
  version: number;
  file: string | null;
}

export interface Snapshot {
  messageIndex: number;
  label: string;
  createdAt: string;
  backups: Record<string, Backup>;
}

export class FileHistory {
  private readonly sessionDir: string;
  private readonly trackedFiles = new Map<string, number>();
  private readonly pendingBackups = new Map<string, Backup>();
  private snapshots: Snapshot[] = [];

  constructor(private readonly baseDir: string, sessionId: string) {
    this.sessionDir = join(baseDir, ".QiCode", "file-history", sessionId);
  }

  static cleanupEmptySessionDirs(baseDir: string): number {
    const root = join(baseDir, ".QiCode", "file-history");
    if (!existsSync(root)) return 0;

    let removed = 0;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(root, entry.name);
        try {
          if (readdirSync(sessionDir).length === 0) {
            rmdirSync(sessionDir);
            removed += 1;
          }
        } catch {
          // One inaccessible history directory must not block startup.
        }
      }
      if (readdirSync(root).length === 0) rmdirSync(root);
    } catch {
      // File history cleanup is best effort.
    }
    return removed;
  }

  trackEdit(filePath: string): void {
    const absolutePath = resolve(this.baseDir, filePath);
    const version = (this.trackedFiles.get(absolutePath) ?? 0) + 1;
    this.trackedFiles.set(absolutePath, version);
    const backupPath = this.backupPath(absolutePath, version);
    if (!existsSync(absolutePath)) {
      try { unlinkSync(backupPath); } catch { /* no pre-edit file */ }
      this.pendingBackups.set(absolutePath, { path: absolutePath, version, file: null });
      return;
    }
    try {
      this.ensureSessionDir();
      writeFileSync(backupPath, readFileSync(absolutePath));
      if (!this.pendingBackups.has(absolutePath)) {
        this.pendingBackups.set(absolutePath, { path: absolutePath, version, file: backupPath });
      }
    } catch {
      // File history is best effort and must not block the edit.
    }
  }

  makeSnapshot(messageIndex: number, userText: string): Snapshot {
    const backups: Record<string, Backup> = {};
    for (const [path, backup] of this.pendingBackups) backups[path] = { ...backup };
    const snapshot: Snapshot = {
      messageIndex,
      label: userText.length > 60 ? `${userText.slice(0, 59)}...` : userText,
      createdAt: new Date().toISOString(),
      backups,
    };
    this.snapshots = [...this.snapshots, snapshot].slice(-MAX_SNAPSHOTS);
    this.pendingBackups.clear();
    return snapshot;
  }

  rewind(snapshotIndex: number): string[] {
    const snapshot = this.snapshots[snapshotIndex];
    if (snapshot === undefined) return [];
    const changed: string[] = [];
    for (const backup of Object.values(snapshot.backups)) {
      try {
        if (backup.file === null) {
          if (existsSync(backup.path)) {
            unlinkSync(backup.path);
            changed.push(backup.path);
          }
          continue;
        }
        const previous = readFileSync(backup.file);
        const current = existsSync(backup.path) ? readFileSync(backup.path) : undefined;
        if (current === undefined || !current.equals(previous)) {
          mkdirSync(dirname(backup.path), { recursive: true });
          writeFileSync(backup.path, previous);
          changed.push(backup.path);
        }
      } catch {
        // One file failing should not prevent other files from being restored.
      }
    }
    this.snapshots = this.snapshots.slice(0, snapshotIndex + 1);
    this.trackedFiles.clear();
    for (const backup of Object.values(snapshot.backups)) this.trackedFiles.set(backup.path, backup.version);
    this.pendingBackups.clear();
    return changed;
  }

  getSnapshots(): Snapshot[] {
    return this.snapshots.map((snapshot) => structuredClone(snapshot));
  }

  hasSnapshots(): boolean {
    return this.snapshots.length > 0;
  }

  hasPendingChanges(): boolean {
    return this.pendingBackups.size > 0;
  }

  private backupPath(filePath: string, version: number): string {
    const name = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
    return join(this.sessionDir, `${name}@v${version}`);
  }

  private ensureSessionDir(): void {
    mkdirSync(this.sessionDir, { recursive: true });
  }
}
