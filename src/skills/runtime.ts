import { SkillCatalog } from "./catalog.js";
import { intersectToolFilters } from "./executor.js";
import { InstallSkillTool } from "./install-tool.js";
import { LoadSkillTool } from "./load-skill-tool.js";
import type { SkillHost, ToolFilter } from "./skill.js";
import type { ToolRegistry } from "../tools/registry.js";

/** 一个 TUI 进程内持有的 Skill 会话状态和系统工具注册入口。 */
export interface SkillRuntime {
  readonly catalog: SkillCatalog;
  readonly activeSkills: Map<string, string>;
  readonly host: SkillHost;
  toolFilter(): ToolFilter | null;
  registerTools(onInstalled: (name: string) => void): void;
}

export function createSkillRuntime(
  workDir: string,
  registry: ToolRegistry,
): SkillRuntime {
  const catalog = new SkillCatalog();
  catalog.load(workDir);

  const activeSkills = new Map<string, string>();
  const filters = new Map<string, ToolFilter>();
  let toolsRegistered = false;
  let combinedFilter: ToolFilter | null = null;
  const refreshFilter = (): void => {
    combinedFilter = intersectToolFilters(filters.values());
  };
  const host: SkillHost = {
    activateSkill: (name, body) => {
      activeSkills.set(name, body);
    },
    setToolFilter: (skillName, filter) => {
      if (filter === null) filters.delete(skillName);
      else filters.set(skillName, filter);
      refreshFilter();
    },
    toolRegistry: () => registry,
  };

  return {
    catalog,
    activeSkills,
    host,
    toolFilter: () => combinedFilter,
    registerTools: (onInstalled) => {
      if (toolsRegistered) return;
      registry.register(new LoadSkillTool(catalog, host));
      registry.register(new InstallSkillTool(workDir, catalog, onInstalled));
      toolsRegistered = true;
    },
  };
}
