import type { Command, CommandRegistry } from "../commands/commands.js";
import { runInline } from "./executor.js";
import type { SkillCatalog } from "./catalog.js";
import type { SkillHost } from "./skill.js";

/** 将当前 Catalog 中的 Skill 映射为第九章的 Slash Command 定义。 */
export function registerSkillCommands(
  catalog: SkillCatalog,
  registry: CommandRegistry,
  host: SkillHost,
  names?: readonly string[],
): string[] {
  const diagnostics: string[] = [];
  const requestedNames = names === undefined ? undefined : new Set(names);

  for (const skill of catalog.list()) {
    if (requestedNames !== undefined && !requestedNames.has(skill.meta.name)) continue;
    const command = skillCommand(skill.meta.name, catalog, host);
    if (registry.hasConflict(command)) {
      diagnostics.push(`Skipped Skill /${skill.meta.name}: name or alias conflicts with an existing command.`);
      continue;
    }

    try {
      registry.register(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`Skipped Skill /${skill.meta.name}: ${message}`);
    }
  }

  return diagnostics;
}

function skillCommand(
  name: string,
  catalog: SkillCatalog,
  host: SkillHost,
): Command {
  const skill = catalog.get(name);
  if (skill === undefined) {
    throw new Error(`Skill '${name}' disappeared while being registered`);
  }

  return {
    name: skill.meta.name,
    aliases: [],
    type: skill.meta.mode === "fork" ? "skill_fork" : "prompt",
    description: `${skill.meta.description || "No description provided."} [skill]`,
    handler: ({ args }) => {
      const latest = catalog.get(skill.meta.name);
      if (latest === undefined) throw new Error(`Skill '${skill.meta.name}' is no longer available`);
      if (latest.meta.mode !== "inline") return "";
      return runInline(latest, args, host);
    },
  };
}
