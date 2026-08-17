import type { Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolSearchTool } from "../tools/tool-search.js";
import type { AgentDefinition } from "./definition.js";

const RECURSIVE_AGENT_TOOL = "Agent";
const BACKGROUND_TOOL_NAMES = new Set(["ReadFile", "Glob", "Grep"]);

export interface SubAgentToolFilterOptions {
  /** 后台任务默认只能读取；角色可通过 background 字段选择该更小的集合。 */
  background?: boolean;
}

/**
 * 构造一个新的 Registry 视图，不会注册、移除或发现父 Registry 中的任何工具。
 * 主 Registry 的 system 工具可能闭包捕获主会话状态，所以不能直接共享；
 * ToolSearch 例外地为子视图重新创建一个实例。
 */
export function createSubAgentToolRegistry(
  parent: ToolRegistry,
  definition: AgentDefinition,
  options: SubAgentToolFilterOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  const allowed = definition.tools === undefined ? undefined : new Set(definition.tools);
  const denied = new Set(definition.disallowedTools ?? []);
  const background = options.background ?? definition.background;

  for (const tool of parent.listTools()) {
    if (!shouldIncludeTool(tool, allowed, denied, background)) continue;
    registry.register(tool);
    if (tool.deferred && parent.isDiscovered(tool.name)) registry.markDiscovered(tool.name);
  }

  // This instance searches only the child view, so select:<tool> cannot mutate the parent.
  registry.register(new ToolSearchTool(registry));
  return registry;
}

function shouldIncludeTool(
  tool: Tool,
  allowed: ReadonlySet<string> | undefined,
  denied: ReadonlySet<string>,
  background: boolean,
): boolean {
  if (tool.name === RECURSIVE_AGENT_TOOL || tool.system === true) return false;
  if (background && !BACKGROUND_TOOL_NAMES.has(tool.name)) return false;
  if (allowed !== undefined && !allowed.has(tool.name)) return false;
  if (denied.has(tool.name)) return false;
  return true;
}
