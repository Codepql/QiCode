import { execFile } from "node:child_process";
import { arch, platform } from "node:os";
import { promisify } from "node:util";
import { resolveShell } from "../tools/shell.js";
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
  type Section,
} from "./sections.js";

const execFileAsync = promisify(execFile);

export class PromptBuilder {
  private readonly sections: Section[] = [];

  add(section: Section): this {
    this.sections.push(section);
    return this;
  }

  build(): string {
    return this.sections
      .toSorted((left, right) => left.priority - right.priority)
      .map((section) => section.content.trim())
      .filter((content) => content.length > 0)
      .join("\n\n");
  }
}

export interface BuildOptions {
  skillSection?: string;
  customInstructions?: string;
  memorySection?: string;
}

export async function detectEnvironment(
  workDir: string,
): Promise<EnvironmentContext> {
  const environment: EnvironmentContext = {
    workDir,
    os: platform(),
    arch: arch(),
    shell: resolveShell().file,
    isGitRepo: false,
    gitBranch: "",
    model: "",
    date: new Date().toISOString().slice(0, 10),
  };

  try {
    const repository = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: workDir, timeout: 2_000 },
    );
    environment.isGitRepo = repository.stdout.trim() === "true";

    if (environment.isGitRepo) {
      const branch = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: workDir, timeout: 2_000 },
      );
      environment.gitBranch = branch.stdout.trim();
    }
  } catch {
    // Git 不可用或当前目录不是仓库时，保留可用的基础环境信息。
  }

  return environment;
}

export function buildSystemPrompt(
  environment: EnvironmentContext,
  options: BuildOptions = {},
): string {
  const builder = new PromptBuilder()
    .add(identitySection())
    .add(systemSection())
    .add(doingTasksSection())
    .add(executingActionsSection())
    .add(usingToolsSection())
    .add(toneStyleSection())
    .add(outputEfficiencySection())
    .add(environmentSection(environment));

  if (options.skillSection) {
    builder.add({ name: "Skills", priority: 90, content: options.skillSection });
  }
  if (options.customInstructions) {
    builder.add({
      name: "CustomInstructions",
      priority: 95,
      content: options.customInstructions,
    });
  }
  if (options.memorySection) {
    builder.add({ name: "Memory", priority: 100, content: options.memorySection });
  }

  return builder.build();
}
