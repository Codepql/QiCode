import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coordinatorToolFilter } from "../../src/teams/coordinator.js";
import { TeamManager } from "../../src/teams/team.js";
import { ListTeamsTool, SendMessageTool, SpawnTeammateTool, TeamCreateTool, TeamDeleteTool } from "../../src/teams/tools.js";

describe("Team orchestration", () => {
  it("reports completed and failed members to the lead mailbox", async () => {
    const directory = tempDirectory();
    try {
      const manager = new TeamManager(directory);
      const team = manager.create("demo");
      team.spawnTeammate("alice", "work", async () => "done");
      await waitFor(() => manager.drainLeadReminders().some((reminder) => reminder.includes("[idle] alice")));
      await team.stopMember("alice");

      team.spawnTeammate("bob", "fail", async () => { throw new Error("boom"); });
      await waitFor(() => manager.drainLeadReminders().some((reminder) => reminder.includes("[failed] bob")));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates, starts, messages, lists, and deletes through tools", async () => {
    const directory = tempDirectory();
    try {
      const manager = new TeamManager(directory);
      const create = new TeamCreateTool(manager);
      const spawn = new SpawnTeammateTool(manager, async () => "done");
      const send = new SendMessageTool(manager);
      const list = new ListTeamsTool(manager);
      const remove = new TeamDeleteTool(manager);

      await expect(create.execute({ name: "demo" })).resolves.toMatchObject({ isError: false });
      await expect(spawn.execute({ team: "demo", name: "alice", task: "work" })).resolves.toMatchObject({ isError: false });
      await expect(send.execute({ team: "demo", to: "alice", message: "next" })).resolves.toMatchObject({ isError: false });
      await expect(list.execute()).resolves.toMatchObject({ output: expect.stringContaining("demo") });
      await expect(remove.execute({ name: "demo" })).resolves.toMatchObject({ isError: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("filters direct write tools only while a team exists", () => {
    const directory = tempDirectory();
    try {
      const manager = new TeamManager(directory);
      const filter = coordinatorToolFilter(manager);
      expect(filter("WriteFile")).toBe(true);
      manager.create("demo");
      expect(filter("WriteFile")).toBe(false);
      expect(filter("ReadFile")).toBe(true);
      expect(filter("mcp__github__create_issue")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "qicode-team-"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for team state");
}
