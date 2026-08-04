import { describe, expect, it } from "vitest";
import {
  doingTasksSection,
  environmentSection,
  executingActionsSection,
  identitySection,
  outputEfficiencySection,
  systemSection,
  toneStyleSection,
  usingToolsSection,
  type EnvironmentContext,
} from "../../src/prompt/sections.js";

describe("prompt sections", () => {
  it("defines the fixed sections in their intended priority order", () => {
    const environment: EnvironmentContext = {
      workDir: "/workspace",
      os: "linux",
      arch: "x64",
      shell: "bash",
      isGitRepo: false,
      gitBranch: "",
      model: "",
      date: "2026-08-03",
    };
    const sections = [
      identitySection(),
      systemSection(),
      doingTasksSection(),
      executingActionsSection(),
      usingToolsSection(),
      toneStyleSection(),
      outputEfficiencySection(),
      environmentSection(environment),
    ];

    expect(sections.map(({ name, priority }) => ({ name, priority }))).toEqual([
      { name: "Identity", priority: 0 },
      { name: "System", priority: 10 },
      { name: "DoingTasks", priority: 20 },
      { name: "ExecutingActions", priority: 30 },
      { name: "UsingTools", priority: 40 },
      { name: "ToneStyle", priority: 50 },
      { name: "TextOutput", priority: 60 },
      { name: "Environment", priority: 70 },
    ]);
  });

  it("renders optional environment values only when available", () => {
    const env: EnvironmentContext = {
      workDir: "E:\\agent-code\\QiCode",
      os: "win32",
      arch: "x64",
      shell: "powershell",
      isGitRepo: true,
      gitBranch: "main",
      model: "test-model",
      date: "2026-07-31",
    };

    const section = environmentSection(env);

    expect(section.priority).toBe(70);
    expect(section.content).toContain("Git 分支：main");
    expect(section.content).toContain("模型：test-model");
  });

  it("keeps base environment facts and omits unavailable Git and model values", () => {
    const section = environmentSection({
      workDir: "/workspace",
      os: "linux",
      arch: "arm64",
      shell: "bash",
      isGitRepo: false,
      gitBranch: "stale-branch",
      model: "",
      date: "2026-08-03",
    });

    expect(section.content).toContain("工作目录：/workspace");
    expect(section.content).toContain("平台：linux/arm64");
    expect(section.content).toContain("Shell：bash");
    expect(section.content).toContain("Git 仓库：否");
    expect(section.content).toContain("日期：2026-08-03");
    expect(section.content).not.toContain("Git 分支：");
    expect(section.content).not.toContain("模型：");
  });
});
