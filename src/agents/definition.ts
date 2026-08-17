import type { PermissionMode } from "../permissions/checker.js";

/** 子 Agent 名称只能是小写 slug，既可作为工具参数，也可安全映射到定义文件名。 */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export const DEFAULT_SUBAGENT_MAX_TURNS = 12;
export const MAX_SUBAGENT_MAX_TURNS = 50;

/**
 * 一个角色是“如何运行子 Agent”的声明，不是正在运行的 Agent 实例。
 * 可变运行时状态（Conversation、权限会话白名单、AbortController、usage）属于 Runner，
 * 不能放在定义对象中。
 */
export interface AgentDefinition {
  name: string;
  description: string;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  systemPromptOverride?: string;
  maxTurns: number;
  model?: string;
  permissionMode: PermissionMode;
  background: boolean;
  /** 第 13 章消费的预留字段；本章不会自动创建 Worktree。 */
  isolation?: "worktree";
  initialPrompt?: string;
  skills?: readonly string[];
  mcpServers?: readonly string[];
}

const READ_ONLY_TOOLS = ["ReadFile", "Glob", "Grep"] as const;

const BUILTIN_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    name: "general-purpose",
    description: "Solve a bounded task with the normal permission policy.",
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
    permissionMode: "default",
    background: false,
  },
  {
    name: "plan",
    description: "Analyze a task and return an implementation plan without making changes.",
    tools: READ_ONLY_TOOLS,
    maxTurns: 8,
    permissionMode: "plan",
    background: false,
  },
  {
    name: "explore",
    description: "Explore the repository and report evidence without modifying files.",
    tools: READ_ONLY_TOOLS,
    maxTurns: 8,
    permissionMode: "plan",
    background: false,
  },
];

/** 返回可安全交给 Loader/Runner 修改的副本，绝不暴露内置常量本身。 */
export function getBuiltinAgentDefinitions(): AgentDefinition[] {
  return BUILTIN_AGENT_DEFINITIONS.map(cloneAgentDefinition);
}

export function isAgentName(value: string): boolean {
  return AGENT_NAME_PATTERN.test(value);
}

export function cloneAgentDefinition(definition: AgentDefinition): AgentDefinition {
  return {
    ...definition,
    ...(definition.tools === undefined ? {} : { tools: [...definition.tools] }),
    ...(definition.disallowedTools === undefined
      ? {}
      : { disallowedTools: [...definition.disallowedTools] }),
    ...(definition.skills === undefined ? {} : { skills: [...definition.skills] }),
    ...(definition.mcpServers === undefined ? {} : { mcpServers: [...definition.mcpServers] }),
  };
}
