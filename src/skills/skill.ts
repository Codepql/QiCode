import type { ToolRegistry } from "../tools/registry.js";

export type SkillMode = "inline" | "fork";
export type ForkContext = "none" | "recent" | "full";
export type ToolFilter = (toolName: string) => boolean;

/**
 * 已通过 frontmatter 校验并归一化的 Skill 元数据。
 * mode 和 forkContext 使用默认值，后续执行器不需要重复判断 undefined。
 */
export interface SkillMeta {
  name: string;
  description: string;
  allowedTools?: string[];
  mode: SkillMode;
  forkContext: ForkContext;
  model?: string;
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  filePath: string;
  sourceDir: string;
  isDirectory: boolean;
}

/** Inline Skill 修改主 Agent 运行时所需的最小能力。
 * Host 由 TUI 持有，但 Skill 执行器不依赖 React。
 */
export interface SkillHost {
  activateSkill(name: string, body: string): void;
  /**
   * 以 Skill 名称为键更新自己的过滤条件。Host 负责把多个 Skill 的条件取交集，
   * 这样后激活的 Skill 不会扩大前一个 Skill 已经收窄的工具范围。
   */
  setToolFilter(skillName: string, filter: ToolFilter | null): void;
  toolRegistry(): ToolRegistry;
}

export interface SkillForkHost extends SkillHost {
  runSubAgent(
    prompt: string,
    allowedTools?: readonly string[],
    model?: string,
  ): Promise<string>;
  snapshotParentMessages(count: number): string;
}
