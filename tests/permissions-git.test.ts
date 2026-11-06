import { describe, expect, it } from "vitest";
import { readOnlyGitCommand } from "../src/permissions/git-readonly.js";
import { isSafeCommand } from "../src/permissions/checker.js";

describe("read-only Git approvals", () => {
  it.each(["git diff", "git diff --stat", "git diff --cached -- src/main.tsx", "git diff -- src/中文.ts", "git log --oneline -10", "git show HEAD:package.json"])("auto-allows %s while disabling executable helpers", (command) => {
    expect(isSafeCommand(command)).toBe(true);
    expect(readOnlyGitCommand(command)).toContain("--no-ext-diff --no-textconv");
  });
  it.each(["git diff --output=file", "git log --output=file", "git diff --ext-diff", "git show --textconv", "git diff && node task.js", "git -c alias.diff=bad diff", "git diff; echo x", "git diff -- \"$(node task.js)\"", "git show --format=bad", "git diff \"unterminated", "git diff “--output=owned.txt”", "git diff \\--output=owned.txt", "git diff ‘--ext-diff’"])("keeps ordinary approval for %s", (command) => {
    expect(readOnlyGitCommand(command)).toBeUndefined();
    expect(isSafeCommand(command)).toBe(false);
  });
});
