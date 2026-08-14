import type { Skill, SkillForkHost, SkillHost, ToolFilter } from "./skill.js";

/**
 * 执行 Inline Skill：先检查声明的工具依赖，再渲染并把 SOP 交给运行时 Host。
 * 这里不持有 React 状态，也不直接调用 Agent。
 */
export function runInline(skill: Skill, args: string, host: SkillHost): string {
  assertAllowedToolsExist(skill, host);
  const body = renderSkillBody(skill.body, args);

  host.activateSkill(skill.meta.name, body);
  host.setToolFilter(skill.meta.name, allowedToolsFilter(skill.meta.allowedTools));
  return body;
}

/** 为 Fork 模式构造独立 prompt，并把实际运行交给 TUI 提供的 Host。 */
export async function runFork(
  skill: Skill,
  args: string,
  host: SkillForkHost,
): Promise<string> {
  assertAllowedToolsExist(skill, host);

  const prompt = withParentContext(
    renderSkillBody(skill.body, args),
    skill.meta.forkContext,
    host,
  );
  return host.runSubAgent(prompt, skill.meta.allowedTools, skill.meta.model);
}

export function renderSkillBody(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  if (args.trim() === "") return body;
  return `${body}\n\nUser Request: ${args}`;
}

/** 将所有已激活 SOP 重新钉到当前 Agent 回合前。 */
export function buildActiveSkillsReminder(
  activeSkills: ReadonlyMap<string, string>,
): string {
  if (activeSkills.size === 0) return "";

  const sections = [...activeSkills.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, body]) => `## Active Skill: ${name}\n\n${body.trim()}`);
  return `# Active Skills\n\n${sections.join("\n\n")}`;
}

/** 将多个已激活 Skill 的白名单收窄为交集；没有白名单时代表不额外限制。 */
export function intersectToolFilters(
  filters: Iterable<ToolFilter | null>,
): ToolFilter | null {
  const activeFilters = [...filters].filter((filter): filter is ToolFilter => filter !== null);
  if (activeFilters.length === 0) return null;
  return (toolName) => activeFilters.every((filter) => filter(toolName));
}

function assertAllowedToolsExist(skill: Skill, host: SkillHost): void {
  for (const toolName of skill.meta.allowedTools ?? []) {
    if (host.toolRegistry().get(toolName) === undefined) {
      throw new Error(
        `Skill '${skill.meta.name}' declares allowed tool '${toolName}' which is not registered`,
      );
    }
  }
}

function allowedToolsFilter(allowedTools: readonly string[] | undefined): ToolFilter | null {
  if (allowedTools === undefined || allowedTools.length === 0) return null;
  const allowed = new Set(allowedTools);
  return (toolName) => allowed.has(toolName);
}

function withParentContext(
  prompt: string,
  mode: Skill["meta"]["forkContext"],
  host: SkillForkHost,
): string {
  const count = mode === "recent" ? 5 : mode === "full" ? 100 : 0;
  if (count === 0) return prompt;

  const parentContext = host.snapshotParentMessages(count).trim();
  if (parentContext === "") return prompt;
  return `# Parent Conversation Context\n\n${parentContext}\n\n${prompt}`;
}
