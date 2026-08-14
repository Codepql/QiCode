import type { ProviderConfig } from "../config/types.js";
import { createProvider, type Provider } from "../llm/client.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import type { EnvironmentContext } from "../prompt/sections.js";
import type { SkillCatalog } from "../skills/catalog.js";
import { BashTool } from "../tools/bash.js";
import { EditFileTool } from "../tools/edit-file.js";
import { GlobTool } from "../tools/glob.js";
import { GrepTool } from "../tools/grep.js";
import { ReadFileTool } from "../tools/read-file.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolSearchTool } from "../tools/tool-search.js";
import { WriteFileTool } from "../tools/write-file.js";

export interface AgentRuntime {
  provider: Provider;
  systemPrompt: string;
}

export type RuntimeFactory = (
  config: ProviderConfig,
  workDir: string,
  skillSection?: string,
) => Promise<AgentRuntime>;

type ProviderFactory = (config: ProviderConfig) => Promise<Provider>;
type EnvironmentDetector = (workDir: string) => Promise<EnvironmentContext>;

/** 兼容测试注入 ProviderFactory，同时支持 App 传入 Skill 清单。 */
export async function initializeAgentRuntime(
  config: ProviderConfig,
  workDir: string,
  skillSectionOrProviderFactory: string | ProviderFactory = "",
  environmentDetector: EnvironmentDetector = detectEnvironment,
): Promise<AgentRuntime> {
  const skillSection = typeof skillSectionOrProviderFactory === "string"
    ? skillSectionOrProviderFactory
    : "";
  const providerFactory = typeof skillSectionOrProviderFactory === "function"
    ? skillSectionOrProviderFactory
    : createProvider;
  const [provider, detectedEnvironment] = await Promise.all([
    providerFactory(config),
    environmentDetector(workDir),
  ]);
  const environment = { ...detectedEnvironment, model: config.model };

  return {
    provider,
    systemPrompt: buildSystemPrompt(environment, { skillSection }),
  };
}

export function startRuntime(
  runtimeFactory: RuntimeFactory,
  config: ProviderConfig,
  workDir: string,
  skillSection = "",
): Promise<AgentRuntime> {
  const runtime = runtimeFactory(config, workDir, skillSection);
  void runtime.catch(() => {});
  return runtime;
}

export function buildSkillSection(catalog: SkillCatalog): string {
  const skills = catalog.list();
  if (skills.length === 0) return "";

  const entries = skills.map((skill) => {
    const mode = skill.meta.mode === "fork" ? "fork; user invocation only" : "inline";
    return `- ${skill.meta.name} [${mode}]: ${skill.meta.description || "No description provided."}`;
  });
  return [
    "# Available Skills",
    "Use the LoadSkill tool only to activate relevant inline Skills. Fork Skills must be started by the user through their Slash command.",
    ...entries,
  ].join("\n");
}

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new ToolSearchTool(registry));
  return registry;
}

export function contextWindowFor(config: ProviderConfig): number {
  return config.protocol === "anthropic" ? 200_000 : 128_000;
}
