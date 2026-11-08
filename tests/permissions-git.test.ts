import { describe, expect, it } from "vitest";
import { readOnlyGitCommand } from "../src/permissions/git-readonly.js";
import { isSafeCommand, prepareSafeCommand } from "../src/permissions/checker.js";

describe("read-only Git approvals", () => {
  it("allows the reported status/echo/log chain and rewrites every Git reader before execution", () => {
    const command = 'git status --short && echo "---" && git log --oneline -5';
    expect(isSafeCommand(command)).toBe(true);
    expect(prepareSafeCommand(command)).toBe('git status --short && echo "---" && git --no-pager log --no-ext-diff --no-textconv --no-show-signature --no-notes --oneline -5');
    expect(prepareSafeCommand('git diff --stat && git show HEAD:package.json')).toBe('git --no-pager diff --no-ext-diff --no-textconv --stat && git --no-pager show --no-ext-diff --no-textconv --no-show-signature --no-notes HEAD:package.json');
    for (const unsafe of ['git status && git log --output=out', 'git log --oneline && node task.js', 'git status && git log “--output=out”', 'git status && git log \\--output=out', 'git status && git log --oneline > out', 'git status && git log -- "$(node task.js)"']) expect(prepareSafeCommand(unsafe), unsafe).toBeUndefined();
  });
  it.each(["git diff", "git diff --stat", "git diff --cached -- src/main.tsx", "git diff -- src/中文.ts", "git log --oneline -10", "git show HEAD:package.json"])("auto-allows %s while disabling executable helpers", (command) => {
    expect(isSafeCommand(command)).toBe(true);
    expect(readOnlyGitCommand(command)).toContain("--no-ext-diff --no-textconv");
  });
  it.each(["git diff --output=file", "git log --output=file", "git diff --ext-diff", "git show --textconv", "git diff && node task.js", "git -c alias.diff=bad diff", "git diff; echo x", "git diff -- \"$(node task.js)\"", "git show --format=bad", "git diff \"unterminated", "git diff “--output=owned.txt”", "git diff \\--output=owned.txt", "git diff ‘--ext-diff’"])("keeps ordinary approval for %s", (command) => {
    expect(readOnlyGitCommand(command)).toBeUndefined();
    expect(isSafeCommand(command)).toBe(false);
  });
});
