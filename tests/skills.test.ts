import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { SkillCatalog, parseSkillFile } from "../src/skills/catalog.js";
import { registerSkillCommands } from "../src/skills/commands.js";
import {
  buildActiveSkillsReminder,
  intersectToolFilters,
  runInline,
} from "../src/skills/executor.js";
import { runSkillForkAgent } from "../src/skills/fork-runner.js";
import { InstallSkillTool, isPublicAddress } from "../src/skills/install-tool.js";
import { LoadSkillTool } from "../src/skills/load-skill-tool.js";
import type { Skill, SkillHost } from "../src/skills/skill.js";
import { CommandRegistry } from "../src/commands/commands.js";
import { Conversation } from "../src/conversation/conversation.js";
import { PermissionChecker } from "../src/permissions/checker.js";
import type { ChatRequest, Provider } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { buildSkillSection } from "../src/tui/runtime.js";

const SKILL_TEXT = [
  "---",
  "name: reviewer",
  "description: Review a change",
  "allowed_tools: [ReadFile]",
  "---",
  "Read $ARGUMENTS and report findings.",
].join("\n");

describe("SkillCatalog", () => {
  it("parses normalized frontmatter and ignores malformed files", () => {
    expect(parseSkillFile(SKILL_TEXT)).toMatchObject({
      meta: {
        name: "reviewer",
        allowedTools: ["ReadFile"],
        mode: "inline",
        forkContext: "none",
      },
      body: "Read $ARGUMENTS and report findings.",
    });
    expect(parseSkillFile("name: missing delimiters")).toBeNull();
    expect(parseSkillFile("---\nname: bad name\n---\nbody")).toBeNull();
  });

  it("loads project Skills and hot-reloads a changed body", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-skills-"));
    const file = join(workDir, ".QiCode", "skills", "reviewer", "SKILL.md");
    mkdirSync(join(workDir, ".QiCode", "skills", "reviewer"), { recursive: true });
    writeFileSync(file, SKILL_TEXT, "utf8");

    const catalog = new SkillCatalog();
    catalog.load(workDir);
    expect(catalog.list().map((skill) => skill.meta.name)).toContain("reviewer");

    const updated = SKILL_TEXT.replace("report findings.", "report concrete findings.");
    writeFileSync(file, updated, "utf8");
    const future = new Date(Date.now() + 2_000);
    utimesSync(file, future, future);
    expect(catalog.get("reviewer")?.body).toContain("concrete findings");
  });
});

describe("Skill execution", () => {
  it("renders arguments, activates the SOP, and fail-fast checks tool names", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile"));
    const activated = new Map<string, string>();
    const filters = new Map<string, (name: string) => boolean>();
    const host: SkillHost = {
      activateSkill: (name, body) => activated.set(name, body),
      setToolFilter: (name, filter) => {
        if (filter === null) filters.delete(name);
        else filters.set(name, filter);
      },
      toolRegistry: () => registry,
    };

    const body = runInline(skill("Read $ARGUMENTS", ["ReadFile"]), "README.md", host);
    expect(body).toBe("Read README.md");
    expect(activated.get("demo")).toBe("Read README.md");
    expect(intersectToolFilters(filters.values())?.("ReadFile")).toBe(true);
    expect(intersectToolFilters(filters.values())?.("Bash")).toBe(false);
    expect(() => runInline(skill("body", ["MissingTool"]), "", host)).toThrow("MissingTool");
    expect(activated.has("demo")).toBe(true);
  });

  it("keeps all active SOPs in the reminder while intersecting restrictive filters", () => {
    const reminder = buildActiveSkillsReminder(new Map([
      ["one", "First SOP"],
      ["two", "Second SOP"],
    ]));
    expect(reminder).toContain("# Active Skills");
    expect(reminder).toContain("## Active Skill: one");
    const filter = intersectToolFilters([
      (name) => name === "ReadFile" || name === "Grep",
      (name) => name === "Grep",
    ]);
    expect(filter?.("Grep")).toBe(true);
    expect(filter?.("ReadFile")).toBe(false);
  });

  it("exposes only allowed plus system tools and rejects a hidden tool call", async () => {
    const registry = new ToolRegistry();
    const hiddenCalls: string[] = [];
    registry.register(recordingTool("Visible", hiddenCalls));
    registry.register(recordingTool("Hidden", hiddenCalls));
    const system = fakeTool("SystemTool");
    system.system = true;
    registry.register(system);
    const provider = new FakeProvider([
      [toolCall("hidden", "Hidden"), { type: "done" }],
      [{ type: "done" }],
    ]);
    const conversation = new Conversation();
    conversation.addUserMessage("task");

    const events = await collect(new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir: process.cwd(),
      checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
      toolFilter: (name) => name === "Visible",
    }).run());

    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["Visible", "SystemTool"]);
    expect(hiddenCalls).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "Hidden",
      isError: true,
    }));
  });

  it("sends one transient Skill reminder per model iteration without persisting duplicates", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile"));
    const provider = new FakeProvider([
      [toolCall("read", "ReadFile"), { type: "done" }],
      [{ type: "text_delta", text: "done" }, { type: "done" }],
    ]);
    const conversation = new Conversation();
    conversation.addUserMessage("task");

    await collect(new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir: process.cwd(),
      checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
      activeSkills: new Map([["reviewer", "Review carefully."]]),
    }).run());

    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) {
      expect(JSON.stringify(request.messages).match(/# Active Skills/g)).toHaveLength(1);
    }
    expect(JSON.stringify(conversation.getMessages())).not.toContain("# Active Skills");
  });
});

describe("Skill tools and command projection", () => {
  it("loads a Skill by name and registers a direct slash command", async () => {
    const workDir = workDirWithSkill(SKILL_TEXT);
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile"));
    const active = new Map<string, string>();
    const host: SkillHost = {
      activateSkill: (name, body) => active.set(name, body),
      setToolFilter: () => {},
      toolRegistry: () => registry,
    };
    const result = await new LoadSkillTool(catalog, host).execute({ name: "reviewer" }, { workDir });
    expect(result).toMatchObject({ isError: false });
    expect(active.get("reviewer")).toBe("Read  and report findings.");

    const commands = new CommandRegistry();
    expect(registerSkillCommands(catalog, commands, host)).toEqual([]);
    expect(commands.find("reviewer")?.handler({ workDir, args: "src" })).toContain("Read src");
  });

  it("refuses to activate a fork Skill through the inline LoadSkill tool", async () => {
    const workDir = workDirWithSkill(SKILL_TEXT.replace(
      "allowed_tools: [ReadFile]",
      "allowed_tools: [ReadFile]\nmode: fork",
    ));
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    const registry = new ToolRegistry();
    registry.register(fakeTool("ReadFile"));
    const active = new Map<string, string>();
    const host: SkillHost = {
      activateSkill: (name, body) => active.set(name, body),
      setToolFilter: () => {},
      toolRegistry: () => registry,
    };

    const result = await new LoadSkillTool(catalog, host).execute(
      { name: "reviewer" },
      { workDir },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("fork");
    expect(active.size).toBe(0);
  });

  it("tells the model that fork Skills are user-invoked rather than LoadSkill targets", () => {
    const workDir = workDirWithSkill(SKILL_TEXT.replace(
      "allowed_tools: [ReadFile]",
      "allowed_tools: [ReadFile]\nmode: fork",
    ));
    const catalog = new SkillCatalog();
    catalog.load(workDir);

    const section = buildSkillSection(catalog);

    expect(section).toContain("inline Skills");
    expect(section).toContain("reviewer [fork; user invocation only]");
  });
});

describe("InstallSkillTool", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects equivalent IPv4 and IPv6 private or loopback addresses", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("0:0:0:0:0:0:0:1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("203.0.113.1")).toBe(false);
    expect(isPublicAddress("203.0.120.1")).toBe(true);
  });

  it("installs a local Skill atomically, reloads the catalog, and honors a name override", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-install-"));
    const source = join(workDir, "template.md");
    writeFileSync(source, SKILL_TEXT, "utf8");
    const catalog = new SkillCatalog();
    const installed: string[] = [];
    const tool = new InstallSkillTool(workDir, catalog, (name) => installed.push(name));

    const result = await tool.execute({ source, name: "review-api" }, { workDir });
    const target = join(workDir, ".QiCode", "skills", "review-api", "SKILL.md");
    expect(result).toMatchObject({ isError: false });
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("name: review-api");
    expect(catalog.has("review-api")).toBe(true);
    expect(installed).toEqual(["review-api"]);
  });

  it("follows a validated HTTPS redirect and installs the downloaded Skill", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-install-"));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.com/reviewer.md" },
      }))
      .mockResolvedValueOnce(new Response(SKILL_TEXT, { status: 200 }));
    const tool = new InstallSkillTool(workDir, new SkillCatalog(), undefined, {
      lookup: async () => [{ address: "93.184.216.34" }],
      fetch: fetcher,
    });

    const result = await tool.execute(
      { source: "https://example.com/reviewer.md" },
      { workDir },
    );

    expect(result.isError).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(join(workDir, ".QiCode", "skills", "reviewer", "SKILL.md"))).toBe(true);
  });

  it("rejects a remote host when any resolved address is private", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-install-"));
    const fetcher = vi.fn();
    const tool = new InstallSkillTool(workDir, new SkillCatalog(), undefined, {
      lookup: async () => [
        { address: "2606:4700:4700::1111" },
        { address: "0:0:0:0:0:0:0:1" },
      ],
      fetch: fetcher,
    });

    const result = await tool.execute(
      { source: "https://example.com/reviewer.md" },
      { workDir },
    );

    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an oversized remote body and leaves no temporary install directory", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-install-"));
    const tool = new InstallSkillTool(workDir, new SkillCatalog(), undefined, {
      lookup: async () => [{ address: "93.184.216.34" }],
      fetch: async () => new Response("x".repeat(512 * 1024 + 1), { status: 200 }),
    });

    const result = await tool.execute(
      { source: "https://example.com/large.md" },
      { workDir },
    );

    expect(result.isError).toBe(true);
    const skillRoot = join(workDir, ".QiCode", "skills");
    expect(existsSync(skillRoot) ? readdirSync(skillRoot) : []).toEqual([]);
  });

  it("aborts a remote download after the total timeout", async () => {
    vi.useFakeTimers();
    const workDir = mkdtempSync(join(tmpdir(), "qicode-install-"));
    const tool = new InstallSkillTool(workDir, new SkillCatalog(), undefined, {
      lookup: async () => [{ address: "93.184.216.34" }],
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });

    const pending = tool.execute(
      { source: "https://example.com/slow.md" },
      { workDir },
    );
    await vi.advanceTimersByTimeAsync(15_001);

    await expect(pending).resolves.toMatchObject({ isError: true });
    await expect(pending).resolves.toHaveProperty("output", expect.stringContaining("timed out"));
  });

  it("does not overwrite an installed Skill or leave a temporary directory", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-install-"));
    const source = join(workDir, "template.md");
    writeFileSync(source, SKILL_TEXT, "utf8");
    const tool = new InstallSkillTool(workDir, new SkillCatalog());

    expect((await tool.execute({ source }, { workDir })).isError).toBe(false);
    expect((await tool.execute({ source }, { workDir })).isError).toBe(true);

    const entries = readdirSync(join(workDir, ".QiCode", "skills"));
    expect(entries).toEqual(["reviewer"]);
    expect(readFileSync(join(workDir, ".QiCode", "skills", "reviewer", "SKILL.md"), "utf8"))
      .toBe(SKILL_TEXT);
  });

  it("rejects a local source outside the workspace without creating an install directory", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-install-"));
    const outside = join(tmpdir(), `outside-${Date.now()}.md`);
    writeFileSync(outside, SKILL_TEXT, "utf8");
    const result = await new InstallSkillTool(workDir, new SkillCatalog()).execute(
      { source: outside },
      { workDir },
    );
    expect(result.isError).toBe(true);
    expect(existsSync(join(workDir, ".QiCode", "skills", "reviewer"))).toBe(false);
  });
});

describe("Fork runner", () => {
  it("returns an isolated assistant result without mutating a parent conversation", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-fork-"));
    const registry = new ToolRegistry();
    const provider = new FakeProvider([[{ type: "text_delta", text: "isolated result" }, { type: "done" }]]);
    const result = await runSkillForkAgent("review this", {
      provider,
      registry,
      catalog: new SkillCatalog(),
      systemPrompt: "system",
      workDir,
      checker: new PermissionChecker(workDir, "bypassPermissions"),
    });
    expect(result).toEqual({ output: "isolated result", interrupted: false });
  });
});

function workDirWithSkill(content: string): string {
  const workDir = mkdtempSync(join(tmpdir(), "qicode-skill-command-"));
  const directory = join(workDir, ".QiCode", "skills", "reviewer");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), content, "utf8");
  return workDir;
}

function skill(body: string, allowedTools: string[] = []): Skill {
  return {
    meta: {
      name: "demo",
      description: "Demo",
      allowedTools,
      mode: "inline",
      forkContext: "none",
    },
    body,
    filePath: "demo.md",
    sourceDir: ".",
    isDirectory: false,
  };
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    category: "read",
    schema: () => ({ name, input_schema: { type: "object" } }),
    execute: async () => ({ output: name, isError: false }),
  };
}

function recordingTool(name: string, calls: string[]): Tool {
  return {
    ...fakeTool(name),
    execute: async () => {
      calls.push(name);
      return { output: name, isError: false };
    },
  };
}

class FakeProvider implements Provider {
  readonly config = {
    name: "fake",
    protocol: "openai" as const,
    model: "fake",
    base_url: "https://example.com/v1",
    api_key: "test",
    thinking: false,
  };
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: StreamEvent[][]) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(request));
    for (const event of this.responses[this.requests.length - 1] ?? []) yield event;
  }
}

function toolCall(toolId: string, toolName: string): StreamEvent {
  return { type: "tool_call_complete", toolId, toolName, arguments: {} };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
