import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const REF_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface GitState {
  /** The Git directory that belongs to this worktree. */
  gitDir: string;
  /** The shared Git directory used for refs and objects. */
  commonGitDir: string;
  headSha: string;
  /** Empty for detached HEAD. */
  branch: string;
}

/**
 * Resolve a repository's .git directory without invoking a git subprocess.
 * Worktrees use a .git file containing a relative or absolute gitdir path.
 */
export function resolveGitDir(repositoryPath: string): string | undefined {
  const root = existingDirectory(repositoryPath);
  if (root === undefined) return undefined;

  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return realpathSync(dotGit);
    if (!statSync(dotGit).isFile()) return undefined;

    const pointer = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (match === null) return undefined;
    const rawPath = match[1]?.trim();
    if (rawPath === undefined || rawPath === "") return undefined;
    const gitDir = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
    return existingDirectory(gitDir);
  } catch {
    return undefined;
  }
}

/** Read HEAD, branch and commit state entirely from Git metadata files. */
export function readGitState(repositoryPath: string): GitState | undefined {
  const gitDir = resolveGitDir(repositoryPath);
  if (gitDir === undefined) return undefined;
  const commonGitDir = resolveCommonGitDir(gitDir);
  if (commonGitDir === undefined) return undefined;

  const head = readText(join(gitDir, "HEAD"));
  if (head === undefined) return undefined;

  if (isValidSha(head)) {
    return { gitDir, commonGitDir, headSha: head, branch: "" };
  }

  if (!head.startsWith("ref: ")) return undefined;
  const ref = head.slice("ref: ".length).trim();
  if (!isSafeGitRef(ref)) return undefined;
  const headSha = resolveRefSha(commonGitDir, ref);
  if (headSha === undefined) return undefined;

  const branch = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : "";
  return { gitDir, commonGitDir, headSha, branch };
}

/** Reject refs that could escape the refs directory or become an option. */
export function isSafeGitRef(ref: string): boolean {
  if (ref === "" || ref.startsWith("-") || ref.includes("@{")) return false;
  const parts = ref.split("/");
  return parts.length >= 2 && parts.every((part) =>
    part !== "." && part !== ".." && REF_SEGMENT_PATTERN.test(part),
  );
}

function resolveCommonGitDir(gitDir: string): string | undefined {
  const commondir = readText(join(gitDir, "commondir"));
  if (commondir === undefined || commondir === "") return gitDir;
  return existingDirectory(resolve(gitDir, commondir));
}

function resolveRefSha(commonGitDir: string, ref: string): string | undefined {
  const looseRef = readText(join(commonGitDir, ...ref.split("/")));
  if (looseRef !== undefined && isValidSha(looseRef)) return looseRef;

  const packedRefs = readText(join(commonGitDir, "packed-refs"));
  if (packedRefs === undefined) return undefined;
  for (const line of packedRefs.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;
    const sha = line.slice(0, separator);
    const packedRef = line.slice(separator + 1).trim();
    if (packedRef === ref && isValidSha(sha)) return sha;
  }
  return undefined;
}

function existingDirectory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function isValidSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}
