import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface UsageEntry {
  usageCount: number;
  lastUsedAt: number;
}

export class CommandUsageTracker {
  readonly #filePath: string;
  readonly #usage = new Map<string, UsageEntry>();

  constructor(workDir: string) {
    this.#filePath = join(workDir, ".QiCode", "command", "command_usage.json");
    this.load();
  }

  record(name: string): void {
    const normalized = name.trim().toLowerCase();
    if (normalized === "") return;

    const existing = this.#usage.get(normalized);
    this.#usage.set(normalized, {
      usageCount: (existing?.usageCount ?? 0) + 1,
      lastUsedAt: Date.now(),
    });
    this.save();
  }

  getScore(name: string): number {
    const entry = this.#usage.get(name.trim().toLowerCase());
    if (!entry) return 0;

    const daysSince = Math.max(0, (Date.now() - entry.lastUsedAt) / 86_400_000);
    const recency = Math.pow(0.5, daysSince / 7);
    return entry.usageCount * Math.max(recency, 0.1);
  }

  getRecentlyUsed(limit = 5): string[] {
    if (limit <= 0) return [];

    return [...this.#usage.keys()]
      .map((name) => ({ name, score: this.getScore(name) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.name);
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

      for (const [name, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (
          typeof entry.usageCount === "number"
          && Number.isFinite(entry.usageCount)
          && entry.usageCount > 0
          && typeof entry.lastUsedAt === "number"
          && Number.isFinite(entry.lastUsedAt)
        ) {
          this.#usage.set(name.trim().toLowerCase(), {
            usageCount: entry.usageCount,
            lastUsedAt: entry.lastUsedAt,
          });
        }
      }
    } catch {
      // A missing or malformed usage file should never block the TUI.
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      writeFileSync(
        this.#filePath,
        `${JSON.stringify(Object.fromEntries(this.#usage), null, 2)}\n`,
        "utf8",
      );
    } catch {
      // Usage ranking is optional; persistence failures are deliberately ignored.
    }
  }
}
