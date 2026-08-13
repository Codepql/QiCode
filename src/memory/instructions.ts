import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MAX_INCLUDE_DEPTH = 5;

export interface InstructionSource {
  path: string;
  content: string;
}

export function loadInstructions(workDir: string): string {
  return discoverInstructions(workDir)
    .map((source) => `Contents of ${displayPath(source.path, workDir)}:\n\n${source.content.trimEnd()}`)
    .join("\n\n---\n\n");
}

export function discoverInstructions(workDir: string): InstructionSource[] {
  const resolvedWorkDir = resolve(workDir);
  const projectRoot = findGitRoot(resolvedWorkDir) ?? resolvedWorkDir;
  const allowedRoots = [canonicalPath(projectRoot), canonicalPath(homedir())];
  const seen = new Set<string>();
  const sources: InstructionSource[] = [];

  for (const filePath of instructionCandidates(resolvedWorkDir)) {
    addSource(sources, seen, filePath, allowedRoots);
  }
  return sources;
}

export function findGitRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function projectInstructionDirs(workDir: string): string[] {
  const resolvedWorkDir = resolve(workDir);
  const root = findGitRoot(resolvedWorkDir);
  if (root === undefined) return [resolvedWorkDir];

  const directories: string[] = [];
  let current = resolvedWorkDir;
  while (true) {
    directories.push(current);
    if (current === root) return directories.reverse();
    current = dirname(current);
  }
}

function instructionCandidates(workDir: string): string[] {
  const candidates = [
    join(homedir(), ".qicode", "QICODE.md"),
    join(homedir(), ".qicode", "AGENTS.md"),
  ];

  for (const directory of projectInstructionDirs(workDir)) {
    candidates.push(join(directory, "QICODE.md"), join(directory, "AGENTS.md"));
  }
  candidates.push(
    join(workDir, ".qicode", "INSTRUCTIONS.md"),
    join(workDir, "QICODE.local.md"),
  );

  return candidates;
}

function addSource(
  sources: InstructionSource[],
  seen: Set<string>,
  candidate: string,
  allowedRoots: readonly string[],
): void {
  const path = existingAllowedPath(candidate, allowedRoots);
  if (path === undefined || seen.has(path)) return;

  const content = readText(path);
  if (content === undefined) return;
  seen.add(path);
  sources.push({
    path,
    content: expandIncludes(content, dirname(path), seen, allowedRoots, 0),
  });
}

function expandIncludes(
  content: string,
  baseDir: string,
  seen: Set<string>,
  allowedRoots: readonly string[],
  depth: number,
): string {
  if (depth >= MAX_INCLUDE_DEPTH) return content;

  let inCodeBlock = false;
  return content.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock) return line;

    const includePath = parseInclude(line.trim());
    if (includePath === "") return line;

    const resolvedPath = resolveInclude(includePath, baseDir);
    const path = existingAllowedPath(resolvedPath, allowedRoots);
    if (path === undefined || seen.has(path)) return line;

    const included = readText(path);
    if (included === undefined) return line;
    seen.add(path);
    return [
      `<!-- included from ${includePath} -->`,
      expandIncludes(included, dirname(path), seen, allowedRoots, depth + 1),
    ].join("\n");
  }).join("\n");
}

function parseInclude(trimmed: string): string {
  if (!trimmed.startsWith("@") || trimmed.startsWith("@@") || /\s/.test(trimmed)) {
    return "";
  }
  const path = trimmed.slice(1);
  return path.startsWith("./")
    || path.startsWith("../")
    || path.startsWith("~/")
    || isAbsolute(path)
    ? path
    : "";
}

function resolveInclude(path: string, baseDir: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function existingAllowedPath(path: string, allowedRoots: readonly string[]): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    const realPath = canonicalPath(path);
    return allowedRoots.some((root) => isWithin(realPath, root)) ? realPath : undefined;
  } catch {
    return undefined;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function displayPath(path: string, workDir: string): string {
  const fromWorkDir = relative(workDir, path);
  return fromWorkDir === "" || (!fromWorkDir.startsWith("..") && !isAbsolute(fromWorkDir))
    ? fromWorkDir || basename(path)
    : path;
}
