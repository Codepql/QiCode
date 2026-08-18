import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitState, resolveGitDir, isSafeGitRef } from "../../src/worktree/git-state.js";
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from "../../src/worktree/worktree.js";
import { EnterWorktreeTool } from "../../src/tools/enter-worktree.js";
import { ExitWorktreeTool } from "../../src/tools/exit-worktree.js";

const execFileAsync = promisify(execFile);
let repository: string;

describe("Worktree lifecycle", () => {
  beforeEach(async () => {
    repository = await createFixtureRepository();
  });

  afterEach(async () => {
    await rm(repository, { recursive: true, force: true });
  });

  it("reads normal Git metadata and rejects unsafe refs", async () => {
    const state = readGitState(repository);

    expect(resolveGitDir(repository)).toBe(join(repository, ".git"));
    expect(state?.branch).toBe("main");
    expect(state?.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(isSafeGitRef("refs/heads/main")).toBe(true);
    expect(isSafeGitRef("../etc")).toBe(false);
    expect(isSafeGitRef("-rf")).toBe(false);
  });

  it("creates a worktree, copies allowed runtime files, and reuses it", async () => {
    const first = await createAgentWorktree("demo", repository);
    expect(first.path).toBe(join(repository, ".QiCode", "worktrees", "demo"));
    expect(first.branch).toBe("worktree-demo");
    expect(first.headCommit).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(first.path, ".QiCode", "agents", "review.md"), "utf8"))
      .resolves.toContain("review");
    await expect(readFile(join(first.path, "runtime", "fixture.txt"), "utf8"))
      .resolves.toBe("fixture");

    const second = await createAgentWorktree("demo", repository);
    expect(second.path).toBe(first.path);
    expect(second.headCommit).toBe(first.headCommit);
  });

  it("detects changes and keeps the worktree when cleanup is unsafe", async () => {
    const result = await createAgentWorktree("changes", repository);
    await expect(hasWorktreeChanges(result.path, result.headCommit)).resolves.toBe(false);
    await writeFile(join(result.path, "README.md"), "changed", "utf8");
    await expect(hasWorktreeChanges(result.path, result.headCommit)).resolves.toBe(true);

    const removal = await removeAgentWorktree(result.path, result.branch, repository);
    expect(removal.worktreeRemoved).toBe(true);
    expect(removal.branchRemoved).toBe(true);
  });

  it("exposes safe Enter and Exit tool behavior", async () => {
    const enter = new EnterWorktreeTool();
    await expect(enter.execute({ slug: "../escape" }, { workDir: repository }))
      .resolves.toMatchObject({ isError: true });

    const created = await enter.execute({ slug: "tool-check" }, { workDir: repository });
    expect(created.isError).toBe(false);
    const path = join(repository, ".QiCode", "worktrees", "tool-check");
    const exit = new ExitWorktreeTool();
    await expect(exit.execute({
      path,
      branch: "worktree-tool-check",
      git_root: repository,
    }, { workDir: repository })).resolves.toMatchObject({
      output: `Worktree cleaned up (no changes): ${path}`,
      isError: false,
    });
  });
});

async function createFixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qicode-worktree-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "qicode@example.test"]);
  await git(root, ["config", "user.name", "QiCode Test"]);
  await mkdir(join(root, ".QiCode", "agents"), { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "README.md"), "fixture", "utf8");
  await writeFile(join(root, ".gitignore"), ".QiCode/*\n", "utf8");
  await writeFile(join(root, ".QiCode", "agents", "review.md"), "review", "utf8");
  await writeFile(join(root, "runtime", "fixture.txt"), "fixture", "utf8");
  await writeFile(join(root, ".worktreeinclude"), "runtime/fixture.txt\n../outside\n", "utf8");
  await git(root, ["add", "README.md", ".gitignore", ".worktreeinclude", "runtime"]);
  await git(root, ["commit", "-m", "fixture"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
