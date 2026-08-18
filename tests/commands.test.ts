import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CommandRegistry,
  createDefaultRegistry,
  parseCommand,
  registerModuleCommands,
  type Command,
} from "../src/commands/commands.js";
import { loadUserCommands, renderBody } from "../src/commands/loader.js";
import { CommandUsageTracker } from "../src/commands/usage-tracker.js";

function command(name: string, aliases: string[] = []): Command {
  return {
    name,
    aliases,
    type: "local",
    description: `${name} command`,
    handler: () => name,
  };
}

describe("CommandRegistry", () => {
  it("rejects names and aliases that collide with existing entries", () => {
    const registry = new CommandRegistry();
    registry.register(command("compact", ["c"]));

    expect(() => registry.register(command("compact"))).toThrow("compact");
    expect(() => registry.register(command("check", ["compact"]))).toThrow("compact");
    expect(() => registry.register(command("c"))).toThrow("c");
  });

  it("finds aliases, returns copies, and completes case-insensitively", () => {
    const registry = new CommandRegistry();
    registry.register(command("status", ["s"]));
    registry.register(command("compact", ["c"]));

    expect(registry.find("S")?.name).toBe("status");
    expect(registry.complete("C").map((entry) => entry.name)).toEqual(["compact"]);
    const listed = registry.listCommands();
    listed[0]?.aliases.push("mutated");
    expect(registry.find("compact")?.aliases).toEqual(["c"]);
  });

  it("parses slash input without treating ordinary text as a command", () => {
    expect(parseCommand("explain this")).toBeNull();
    expect(parseCommand("/help compact details")).toEqual({
      name: "help",
      args: "compact details",
    });
  });

  it("lets modules register commands and action handlers without replacing earlier entries", async () => {
    const registry = createDefaultRegistry();
    expect(registerModuleCommands(registry, [command("help")])).toEqual([
      "Command /help conflicts with an existing command.",
    ]);
    expect(registerModuleCommands(registry, [command("skills")])).toEqual([
      "Command /skills conflicts with an existing command.",
    ]);
    expect(registry.find("skills")?.type).toBe("local_ui");

    const calls: string[] = [];
    registry.registerActionHandler("open-skills", async (args) => { calls.push(args); });
    await registry.getActionHandler("OPEN-SKILLS")?.("typescript");
    expect(calls).toEqual(["typescript"]);
  });
});

describe("user command loader", () => {
  it("loads project Markdown commands with frontmatter, namespaces, and argument rendering", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-commands-"));
    const commandDir = join(workDir, ".QiCode", "commands", "git");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, "sync.md"), [
      "---",
      "description: Sync a branch",
      "aliases: [gs]",
      "argument-hint: branch",
      "---",
      "Sync $ARGUMENTS now.",
    ].join("\n"), "utf8");

    const loaded = loadUserCommands(workDir).find((entry) => entry.name === "git:sync");
    expect(loaded).toMatchObject({
      aliases: ["gs"],
      type: "prompt",
      description: "Sync a branch",
      argumentHint: "branch",
    });
    expect(loaded?.handler({ workDir, args: "main" })).toBe("Sync main now.");
    expect(renderBody("Run review", "auth")).toBe("Run review\n\nauth");
  });
});

describe("CommandUsageTracker", () => {
  it("persists usage and ranks recently used commands", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-usage-"));
    const tracker = new CommandUsageTracker(workDir);
    tracker.record("help");
    tracker.record("help");
    tracker.record("status");

    expect(tracker.getScore("help")).toBeGreaterThan(tracker.getScore("status"));
    expect(tracker.getRecentlyUsed()).toEqual(["help", "status"]);
    expect(JSON.parse(readFileSync(join(workDir, ".QiCode", "command", "command_usage.json"), "utf8"))).toMatchObject({
      help: { usageCount: 2 },
      status: { usageCount: 1 },
    });
  });
});
