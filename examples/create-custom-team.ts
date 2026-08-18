import { TeamManager } from "../src/teams/team.js";

const manager = new TeamManager(process.cwd());
const team = manager.get("custom") ?? manager.create("custom");
team.addMember("alice");
team.addMember("bob");

console.log(`Team: ${team.name} (${team.mode})`);
for (const member of team.listMembers()) {
  console.log(`- ${member.name}: ${member.active ? "active" : "idle"}`);
}
