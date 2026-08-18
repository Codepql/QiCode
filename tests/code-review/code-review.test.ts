import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCodeReviewCommand } from "../../src/code-review/handler.js";
import { CodeReviewManager, createDefaultCodeReviewTeam } from "../../src/code-review/manager.js";
import { ReviewSession } from "../../src/code-review/session.js";
import { TeamManager } from "../../src/teams/team.js";

describe("CodeReviewManager and ReviewSession", () => {
  it("creates a review team, persists it, and mirrors it into TeamManager", () => {
    const directory = tempDirectory();
    try {
      const runtimeManager = new TeamManager(directory);
      const manager = new CodeReviewManager(directory, runtimeManager);
      manager.createTeam("review", createDefaultCodeReviewTeam());
      expect(manager.getActiveReviewers("review").map((member) => member.name)).toEqual(["alice", "bob"]);
      expect(runtimeManager.get("review")?.listMembers()).toHaveLength(3);
      expect(existsSync(join(directory, ".QiCode", "code-review-teams.json"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks comments, critic assessments, and final reports", () => {
    const directory = tempDirectory();
    try {
      const manager = new CodeReviewManager(directory, new TeamManager(directory));
      manager.createTeam("review", createDefaultCodeReviewTeam());
      const session = new ReviewSession(directory, manager);
      const request = session.createReviewRequest("review", "Fix parser", "Review the parser", "dev", "main", ["src/parser.ts"]);
      const comment = session.addComment(request.id, "alice", "Handle empty input", "src/parser.ts", 12);
      session.addCriticAssessment(request.id, comment.id, "charlie", "reasonable", "The empty input path is missing.");
      session.acceptComment(request.id, comment.id, "Fixed.");
      expect(session.formatFinalReport(session.generateFinalReport(request.id))).toContain("1 accepted");
      expect(session.getCriticSummary(request.id)).toContain("empty input path");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports slash-command errors instead of throwing", () => {
    const directory = tempDirectory();
    try {
      const manager = new CodeReviewManager(directory, new TeamManager(directory));
      const session = new ReviewSession(directory, manager);
      expect(handleCodeReviewCommand({ workDir: directory, args: "create review" }, manager, session)).toContain("created");
      expect(handleCodeReviewCommand({ workDir: directory, args: "status missing" }, manager, session)).toMatch(/^Error:/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "qicode-review-"));
}
