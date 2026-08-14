import { runInline } from "./executor.js";
import type { SkillCatalog } from "./catalog.js";
import type { SkillHost } from "./skill.js";
import { strArg, type Tool, type ToolContext, type ToolResult } from "../tools/types.js";

/** 模型按需加载完整 Skill SOP 的系统工具。 */
export class LoadSkillTool implements Tool {
  readonly name = "LoadSkill";
  readonly description = "Load and activate a named Skill when its SOP is relevant to the current task.";
  readonly category = "read" as const;
  readonly system = true;

  constructor(
    private readonly catalog: SkillCatalog,
    private readonly host: SkillHost,
  ) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The Skill name shown in the available Skills list.",
          },
        },
        required: ["name"],
      },
    };
  }

  async execute(
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const name = strArg(args, "name").trim();
    const skill = this.catalog.get(name);
    if (skill === undefined) {
      const available = this.catalog.list().map((item) => item.meta.name).join(", ") || "(none)";
      return {
        output: `Skill '${name}' not found. Available skills: ${available}`,
        isError: true,
      };
    }
    if (skill.meta.mode === "fork") {
      return {
        output: `Skill '${skill.meta.name}' uses fork mode and must be started with /${skill.meta.name}.`,
        isError: true,
      };
    }

    try {
      const body = runInline(skill, "", this.host);
      return {
        output: `Skill '${skill.meta.name}' activated.\n\n${body}`,
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Skill '${skill.meta.name}' could not activate: ${message}`, isError: true };
    }
  }
}
