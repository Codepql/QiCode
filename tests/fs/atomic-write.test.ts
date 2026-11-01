import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), renameSync: vi.fn() }));
import { renameSync } from "node:fs";
import { atomicWriteFile } from "../../src/fs/atomic-write.js";
import { assertFileVersion, contentHash } from "../../src/fs/file-access.js";

const directories: string[] = [];
afterEach(() => { vi.mocked(renameSync).mockReset(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("atomic file replacement", () => {
  it("keeps original bytes and removes the temporary file if rename fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "qicode-atomic-"));
    directories.push(directory);
    const path = join(directory, "source.txt");
    writeFileSync(path, "original");
    vi.mocked(renameSync).mockImplementation(() => { throw new Error("rename failed"); });
    expect(() => atomicWriteFile(path, "new")).toThrow("rename failed");
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(readdirSync(directory)).toEqual(["source.txt"]);
  });

  it("preserves existing executable bits on replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qicode-atomic-"));
    directories.push(directory);
    const path = join(directory, "script.sh");
    writeFileSync(path, "old", { mode: 0o755 });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation(actual.renameSync);
    atomicWriteFile(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it("does not replace changes made while the temporary file was being prepared", () => {
    const directory = mkdtempSync(join(tmpdir(), "qicode-atomic-"));
    directories.push(directory);
    const path = join(directory, "source.txt");
    writeFileSync(path, "original");
    expect(() => atomicWriteFile(path, "agent", () => {
      writeFileSync(path, "user edit");
      assertFileVersion(path, contentHash("original"));
    })).toThrow("changed since it was read");
    expect(readFileSync(path, "utf8")).toBe("user edit");
    expect(readdirSync(directory)).toEqual(["source.txt"]);
  });

  it.skipIf(process.platform === "win32")("preserves permission bits that the current umask would remove", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qicode-atomic-"));
    directories.push(directory);
    const path = join(directory, "shared.txt");
    writeFileSync(path, "original");
    chmodSync(path, 0o777);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation(actual.renameSync);
    atomicWriteFile(path, "new");
    expect(statSync(path).mode & 0o777).toBe(0o777);
  });
});
