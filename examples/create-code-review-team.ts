import { CodeReviewManager, createDefaultCodeReviewTeam } from "../src/code-review/manager.js";
import { TeamManager } from "../src/teams/team.js";

const workDir = process.cwd();
const teamManager = new TeamManager(workDir);
const reviewManager = new CodeReviewManager(workDir, teamManager);
const existing = reviewManager.getTeam("demo-review");
const team = existing ?? reviewManager.createTeam("demo-review", createDefaultCodeReviewTeam());

console.log(`Review team: ${team.name}`);
console.log(reviewManager.getTeamSummary(team.name));
for (const member of team.members) {
  console.log(`- ${member.name} <${member.email}>: ${member.role} (${member.expertise.join(", ")})`);
}
