import { Agent, type AgentConfig } from "../agent/agent.js";
import { resolveBudget, type EffectiveBudget } from "../agent/budgets.js";
import type { ExecutionSettings, ModelCapabilities } from "../agent/execution.js";
import { recordMetrics, endpointIdentity, type RunMetrics } from "../metrics/run-metrics.js";
import { Conversation } from "../conversation/conversation.js";
import type { FileHistory } from "../filehistory/filehistory.js";
import type { Provider } from "../llm/client.js";
import { PermissionChecker } from "../permissions/checker.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolSearchTool } from "../tools/tool-search.js";
import type { ToolRegistry as MainToolRegistry } from "../tools/registry.js";
import { SkillCatalog } from "./catalog.js";
import { intersectToolFilters } from "./executor.js";
import { LoadSkillTool } from "./load-skill-tool.js";
import type { ToolFilter } from "./skill.js";

export interface ForkRunnerConfig {
  provider: Provider;
  registry: MainToolRegistry;
  catalog: SkillCatalog;
  systemPrompt: string;
  workDir: string;
  checker: PermissionChecker;
  allowedTools?: readonly string[];
  abortSignal?: AbortSignal;
  contextWindow?: number;
  maxOutput?: number;
  budget?: EffectiveBudget;
  modelCapabilities?: Record<string, ModelCapabilities>;
  execution?: Partial<ExecutionSettings>;
  metrics?: RunMetrics;
  parentRunId?: string;
  fileHistory?: FileHistory;
  onPermissionRequest?: AgentConfig["onPermissionRequest"];
  reminders?: readonly string[];
}

export interface ForkRunResult {
  output: string;
  interrupted: boolean;
}

/**
 * 为 Fork Skill 运行独立 Agent。它不会读取或写入主 Conversation，
 * 但复用当前 Provider、工作目录、工具实现和权限策略。
 */
export async function runSkillForkAgent(
  prompt: string,
  config: ForkRunnerConfig,
): Promise<ForkRunResult> {
  const conversation = new Conversation();
  for (const reminder of config.reminders ?? []) {
    if (reminder.trim() !== "") conversation.addSystemReminder(reminder);
  }
  conversation.addUserMessage(prompt);

  const registry = createForkRegistry(config.registry);
  const activeSkills = new Map<string, string>();
  const filters = new Map<string, ToolFilter>();
  const initialFilter = allowedToolsFilter(config.allowedTools);
  if (initialFilter !== null) filters.set("__fork__", initialFilter);

  const host = {
    activateSkill: (name: string, body: string) => {
      activeSkills.set(name, body);
    },
    setToolFilter: (name: string, filter: ToolFilter | null) => {
      if (filter === null) filters.delete(name);
      else filters.set(name, filter);
    },
    toolRegistry: () => registry,
  };
  registry.register(new LoadSkillTool(config.catalog, host));

  const budget = config.budget ?? resolveBudget(config.provider.config.model, config.modelCapabilities, config.execution,
    { ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }), ...(config.maxOutput === undefined ? {} : { maxOutput: config.maxOutput }) }, config.provider.config.base_url);
  const metrics = config.metrics ?? recordMetrics(config.workDir, { model: config.provider.config.model, protocol: config.provider.config.protocol, contextWindow: budget.contextWindow, maxOutput: budget.maxOutput, budgetSource: budget.source,
    ...(config.parentRunId ? { parentRunId: config.parentRunId } : {}), endpointId: endpointIdentity(config.provider.config.base_url) });
  const agent = new Agent({
    budget, metrics, finishMetrics: false,
    provider: config.provider,
    registry,
    conversation,
    systemPrompt: config.systemPrompt,
    workDir: config.workDir,
    checker: config.checker,
    activeSkills,
    toolFilter: (toolName) => intersectToolFilters(filters.values())?.(toolName) ?? true,
    ...(config.abortSignal === undefined ? {} : { abortSignal: config.abortSignal }),
    ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
    ...(config.maxOutput === undefined ? {} : { maxOutput: config.maxOutput }),
    ...(config.fileHistory === undefined ? {} : { fileHistory: config.fileHistory }),
    ...(config.onPermissionRequest === undefined
      ? {}
      : { onPermissionRequest: config.onPermissionRequest }),
  });

  let error = "";
  try {
    for await (const event of agent.run()) {
      if (event.type === "error") error = event.message;
    }
  } catch (caught) { metrics.outcome = config.abortSignal?.aborted ? "interrupted" : "error"; throw caught; }
  finally { if (!config.metrics) metrics.finish(); }
  if (error !== "") throw new Error(error);
  if (config.abortSignal?.aborted) return { output: "", interrupted: true };

  const lastMessage = conversation.getMessages().at(-1);
  return {
    output: lastMessage?.role === "assistant" ? Conversation.visibleText(lastMessage) : "",
    interrupted: false,
  };
}

function createForkRegistry(mainRegistry: MainToolRegistry): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of mainRegistry.listTools()) {
    // 主会话的系统工具可能闭包捕获了主状态；Fork 只重新注册安全的本地版本。
    if (tool.system === true) continue;
    registry.register(tool);
  }
  registry.register(new ToolSearchTool(registry));
  return registry;
}

function allowedToolsFilter(allowedTools: readonly string[] | undefined): ToolFilter | null {
  if (allowedTools === undefined || allowedTools.length === 0) return null;
  const allowed = new Set(allowedTools);
  return (toolName) => allowed.has(toolName);
}
