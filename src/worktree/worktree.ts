import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readGitState } from "./git-state.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { canonicalFilePath, contentHash, withFileLock } from "../fs/file-access.js";

const execFileAsync = promisify(execFile);
const WORKTREE_DIRECTORY = ".QiCode";
const WORKTREE_BRANCH_PREFIX = "worktree-";
const WORKTREE_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const SHARED_QICODE_ENTRIES = ["agents", "skills"] as const;
const FORBIDDEN_INCLUDE_ROOTS = new Set([".git", ".QiCode", "node_modules"]);

export interface WorktreeResult {
  path: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
  warnings: string[];
}

export interface WorktreeRemovalResult {
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  warnings: string[];
}

interface WorktreeRecord {
  version: 1;
  path: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
  ignoredFiles: Record<string, string>;
}

/**
 * Create an isolated worktree or restore an existing managed worktree.
 * The existing-directory path reads Git metadata first and does not run
 * `git worktree add` again.
 */
export async function createAgentWorktree(
  slug: string,
  gitRoot?: string,
): Promise<WorktreeResult> {
  if (!isValidWorktreeSlug(slug)) {
    throw new Error("slug must contain only alphanumeric characters, hyphen, and underscore");
  }

  const root = await resolveGitRoot(gitRoot);
  const branch = `${WORKTREE_BRANCH_PREFIX}${slug}`;
  const path = managedWorktreePath(root, slug);
  const recordPath = worktreeRecordPath(root, slug);
  mkdirSync(dirname(recordPath), { recursive: true });

  return withFileLock(recordPath, async () => {

  if (existsSync(path)) {
    const state = readGitState(path);
    if (state === undefined) {
      throw new Error(`existing worktree has unreadable Git state: ${path}`);
    }
    if (state.branch !== branch) {
      throw new Error(`existing worktree uses unexpected branch: ${state.branch || "detached HEAD"}`);
    }
    if (!sameRepository(state.commonGitDir, readGitState(root)?.commonGitDir)) {
      throw new Error("existing directory belongs to another repository");
    }
    const record = readWorktreeRecord(root, slug);
    return {
      path, branch, headCommit: record?.headCommit ?? state.headSha, gitRoot: root,
      warnings: record === undefined ? ["No saved creation baseline; automatic cleanup is disabled."] : [],
    };
  }

  mkdirSync(join(root, WORKTREE_DIRECTORY, "worktrees"), { recursive: true });
  // -b fails if the branch exists; it must never reset another task's commits.
  await runGit(root, ["worktree", "add", "-b", branch, path]);
  const state = readGitState(path);
  const headCommit = state?.headSha ?? await runGit(path, ["rev-parse", "HEAD"]);
  if (headCommit === "") throw new Error("created worktree has no HEAD commit");
  const record: WorktreeRecord = { version: 1, path, branch, headCommit, gitRoot: root, ignoredFiles: {} };
  atomicWriteFile(recordPath, JSON.stringify(record));
  const warnings = await performPostCreationSetup(root, path);
  record.ignoredFiles = await ignoredFileSnapshot(path);
  atomicWriteFile(recordPath, JSON.stringify(record));
  return { path, branch, headCommit, gitRoot: root, warnings };
  });
}

/**
 * Treat every observation failure as a change. A caller must never remove a
 * worktree merely because Git state could not be inspected.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  baseCommit: string,
): Promise<boolean> {
  try {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(baseCommit)) return true;
    const status = await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
    if (status !== "") return true;

    const currentHead = readGitState(worktreePath)?.headSha
      ?? await runGit(worktreePath, ["rev-parse", "HEAD"]);
    return currentHead !== baseCommit;
  } catch {
    return true;
  }
}

/**
 * Remove only a directory and branch created by this module. Git failures are
 * reported as warnings so a missing external worktree does not crash the app.
 */
export async function removeAgentWorktree(
  worktreePath: string,
  branch: string,
  gitRoot: string,
): Promise<WorktreeRemovalResult> {
  const root = existingDirectory(gitRoot);
  if (root === undefined) throw new Error("git root must be an existing directory");
  const slug = managedSlugForPath(root, worktreePath);
  if (slug === undefined) throw new Error("worktree path is outside the managed worktree directory");
  if (branch !== `${WORKTREE_BRANCH_PREFIX}${slug}`) {
    throw new Error("branch does not match the managed worktree path");
  }

  return withFileLock(worktreeRecordPath(root, slug), async () => {
  const record = readWorktreeRecord(root, slug);
  const state = readGitState(worktreePath);
  if (record === undefined || state?.branch !== branch
    || !sameRepository(state.commonGitDir, readGitState(root)?.commonGitDir)
    || await hasWorktreeChanges(worktreePath, record.headCommit)
    || !await ignoredFilesUnchanged(worktreePath, record.ignoredFiles)) {
    return {
      worktreeRemoved: false, branchRemoved: false,
      warnings: ["Worktree kept: changes, new commits, an unknown baseline, or unverifiable repository state."],
    };
  }

  const warnings: string[] = [];
  let worktreeRemoved = false;
  let branchRemoved = false;
  try {
    await runGit(root, ["worktree", "remove", worktreePath]);
    worktreeRemoved = true;
  } catch (error) {
    warnings.push(`could not remove worktree: ${errorMessage(error)}`);
  }
  if (worktreeRemoved) try {
    await runGit(root, ["branch", "-d", branch]);
    branchRemoved = true;
  } catch (error) {
    warnings.push(`could not delete branch: ${errorMessage(error)}`);
  }
  return { worktreeRemoved, branchRemoved, warnings };
  });
}

function worktreeRecordPath(root: string, slug: string): string {
  return join(root, WORKTREE_DIRECTORY, "worktree-state", `${slug}.json`);
}

function sameRepository(left: string, right: string | undefined): boolean {
  if (right === undefined) return false;
  const first = canonicalFilePath(left);
  const second = canonicalFilePath(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function readWorktreeRecord(root: string, slug: string): WorktreeRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(worktreeRecordPath(root, slug), "utf8")) as Partial<WorktreeRecord>;
    if (value.version !== 1 || value.path !== managedWorktreePath(root, slug)
      || value.gitRoot !== root || value.branch !== `${WORKTREE_BRANCH_PREFIX}${slug}`
      || typeof value.ignoredFiles !== "object" || value.ignoredFiles === null
      || typeof value.headCommit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.headCommit)) return undefined;
    return value as WorktreeRecord;
  } catch { return undefined; }
}

async function ignoredFileSnapshot(path: string): Promise<Record<string, string>> {
  const files = (await runGit(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z",
    "--", ".", ":(exclude)node_modules", ":(exclude)node_modules/**"])).split("\0").filter(Boolean);
  const hashes: Record<string, string> = {};
  for (const file of files.sort()) {
    const target = join(path, file);
    hashes[file] = lstatSync(target).isSymbolicLink()
      ? `link:${readlinkSync(target)}` : contentHash(readFileSync(target));
  }
  const modules = join(path, "node_modules");
  if (existsSync(modules) && !lstatSync(modules).isSymbolicLink()) {
    throw new Error("Automatic worktree cleanup is disabled for a private node_modules directory");
  }
  return hashes;
}

async function ignoredFilesUnchanged(path: string, baseline: Record<string, string>): Promise<boolean> {
  try { return JSON.stringify(await ignoredFileSnapshot(path)) === JSON.stringify(baseline); }
  catch { return false; }
}

export function isValidWorktreeSlug(slug: string): boolean {
  return WORKTREE_SLUG_PATTERN.test(slug);
}

export function buildWorktreeNotice(parentCwd: string, worktreePath: string): string {
  return [
    `You are working in the isolated worktree: ${worktreePath}`,
    `The parent workspace is: ${parentCwd}`,
    "Changes here do not modify the parent workspace until you merge or copy them explicitly.",
  ].join("\n");
}

async function resolveGitRoot(gitRoot: string | undefined): Promise<string> {
  if (gitRoot !== undefined) {
    const root = existingDirectory(gitRoot);
    if (root === undefined) throw new Error("git root must be an existing directory");
    return root;
  }
  const root = await runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const existingRoot = existingDirectory(root);
  if (existingRoot === undefined) throw new Error("Git returned an invalid repository root");
  return existingRoot;
}

function managedWorktreePath(gitRoot: string, slug: string): string {
  return join(gitRoot, WORKTREE_DIRECTORY, "worktrees", slug);
}

function managedSlugForPath(gitRoot: string, worktreePath: string): string | undefined {
  const root = resolve(gitRoot, WORKTREE_DIRECTORY, "worktrees");
  const candidate = resolve(worktreePath);
  const relativePath = relative(root, candidate);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined;
  if (relativePath.includes(sep)) return undefined;

  // A symlink placed under the managed directory must not turn cleanup into an
  // operation on an external directory.
  if (existsSync(candidate)) {
    const actualPath = existingDirectory(candidate);
    if (actualPath === undefined) return undefined;
    const actualRelativePath = relative(root, actualPath);
    if (actualRelativePath === "" || actualRelativePath.startsWith(`..${sep}`) || isAbsolute(actualRelativePath)) {
      return undefined;
    }
  }
  return isValidWorktreeSlug(basename(candidate)) ? basename(candidate) : undefined;
}

/** Run independent setup steps without turning a created worktree into a failure. */
async function performPostCreationSetup(gitRoot: string, worktreePath: string): Promise<string[]> {
  const warnings: string[] = [];
  copySharedQicodeDefinitions(gitRoot, worktreePath, warnings);
  await configureHooksPath(gitRoot, worktreePath, warnings);
  linkNodeModules(gitRoot, worktreePath, warnings);
  copyWorktreeIncludeFiles(gitRoot, worktreePath, warnings);
  return warnings;
}

function copySharedQicodeDefinitions(gitRoot: string, worktreePath: string, warnings: string[]): void {
  const sourceRoot = join(gitRoot, WORKTREE_DIRECTORY);
  const targetRoot = join(worktreePath, WORKTREE_DIRECTORY);
  for (const entry of SHARED_QICODE_ENTRIES) {
    const source = join(sourceRoot, entry);
    if (!existsSync(source)) continue;
    try {
      mkdirSync(targetRoot, { recursive: true });
      cpSync(source, join(targetRoot, entry), { recursive: true, force: true });
    } catch (error) {
      warnings.push(`could not copy .QiCode/${entry}: ${errorMessage(error)}`);
    }
  }
}

async function configureHooksPath(gitRoot: string, worktreePath: string, warnings: string[]): Promise<void> {
  const candidates = [join(gitRoot, ".husky"), join(gitRoot, ".git", "hooks")];
  const hooksPath = candidates.map(existingDirectory).find((path) => path !== undefined);
  if (hooksPath === undefined) return;
  try {
    await runGit(worktreePath, ["config", "core.hooksPath", hooksPath]);
  } catch (error) {
    warnings.push(`could not configure hooks: ${errorMessage(error)}`);
  }
}

function linkNodeModules(gitRoot: string, worktreePath: string, warnings: string[]): void {
  const source = join(gitRoot, "node_modules");
  const target = join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(target)) return;
  try {
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    warnings.push(`could not link node_modules: ${errorMessage(error)}`);
  }
}

function copyWorktreeIncludeFiles(gitRoot: string, worktreePath: string, warnings: string[]): void {
  const includeFile = join(gitRoot, ".worktreeinclude");
  if (!existsSync(includeFile)) return;
  let entries: string[];
  try {
    entries = readFileSync(includeFile, "utf8").split(/\r?\n/);
  } catch (error) {
    warnings.push(`could not read .worktreeinclude: ${errorMessage(error)}`);
    return;
  }

  for (const entry of entries) {
    const path = entry.trim();
    if (path === "" || path.startsWith("#")) continue;
    if (!isSafeIncludePath(path)) {
      warnings.push(`skipped unsafe .worktreeinclude path: ${path}`);
      continue;
    }
    const source = resolve(gitRoot, path);
    const target = resolve(worktreePath, path);
    if (!isPathInside(gitRoot, source) || !isPathInside(worktreePath, target) || !existsSync(source)) continue;
    try {
      if (lstatSync(source).isSymbolicLink()) {
        warnings.push(`skipped symbolic link in .worktreeinclude: ${path}`);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`could not copy .worktreeinclude path ${path}: ${errorMessage(error)}`);
    }
  }
}

function isSafeIncludePath(path: string): boolean {
  if (isAbsolute(path)) return false;
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return !FORBIDDEN_INCLUDE_ROOTS.has(parts[0] ?? "");
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return args.includes("-z") ? stdout : stdout.trim();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

function existingDirectory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const details = error as { stderr?: string | Buffer; message?: string };
  const stderr = details.stderr?.toString().trim();
  return stderr === "" || stderr === undefined ? (details.message ?? "Git command failed") : stderr;
}
