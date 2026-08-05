import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PromptBuilder,
  buildSystemPrompt,
  detectEnvironment,
} from "../../src/prompt/builder.js";
import {
  identitySection,
  usingToolsSection,
  type EnvironmentContext,
} from "../../src/prompt/sections.js";

const fakeEnvironment: EnvironmentContext = {
  workDir: "E:\\agent-code\\QiCode",
  os: "win32",
  arch: "x64",
  shell: "powershell",
  isGitRepo: true,
  gitBranch: "main",
  model: "test-model",
  date: "2026-08-03",
};

describe("PromptBuilder", () => {
  it("sorts sections by priority instead of insertion order", () => {
    const prompt = new PromptBuilder()
      .add(usingToolsSection())
      .add(identitySection())
      .build();

    expect(prompt.indexOf("你是 QiCode")).toBeLessThan(
      prompt.indexOf("# 使用你的工具"),
    );
  });

  it("trims content and skips empty sections", () => {
    const prompt = new PromptBuilder()
      .add({ name: "Empty", priority: 0, content: "   " })
      .add({ name: "First", priority: 10, content: "  第一段  " })
      .add({ name: "Second", priority: 20, content: "第二段" })
      .build();

    expect(prompt).toBe("第一段\n\n第二段");
  });
});

describe("buildSystemPrompt", () => {
  it("assembles all fixed sections and tool guidance in priority order", () => {
    const prompt = buildSystemPrompt(fakeEnvironment);
    const markers = [
      "你是 QiCode",
      "# 系统约定",
      "# 任务执行",
      "# 谨慎执行操作",
      "# 使用你的工具",
      "# 语气与风格",
      "# 文本输出",
      "# 环境",
    ];

    const positions = markers.map((marker) => prompt.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(prompt).toContain("ReadFile");
    expect(prompt).toContain("Bash");
    expect(prompt).toContain("EditFile");
  });

  it("returns stable output for the same environment", () => {
    expect(buildSystemPrompt(fakeEnvironment)).toBe(
      buildSystemPrompt(fakeEnvironment),
    );
  });

  it("appends only the optional sections that contain content", () => {
    const prompt = buildSystemPrompt(fakeEnvironment, {
      skillSection: "已激活技能",
      customInstructions: "项目指令",
      memorySection: "长期记忆",
    });

    expect(prompt.indexOf("已激活技能")).toBeLessThan(
      prompt.indexOf("项目指令"),
    );
    expect(prompt.indexOf("项目指令")).toBeLessThan(
      prompt.indexOf("长期记忆"),
    );
    expect(buildSystemPrompt(fakeEnvironment)).not.toContain("已激活技能");
  });
});

describe("detectEnvironment", () => {
  it("returns a usable environment even outside a Git repository", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "qicode-prompt-"));

    try {
      const env = await detectEnvironment(workDir);

      expect(env.workDir).toBe(workDir);
      expect(env.os).not.toBe("");
      expect(env.arch).not.toBe("");
      expect(env.isGitRepo).toBe(false);
      expect(env.gitBranch).toBe("");
      expect(env.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
