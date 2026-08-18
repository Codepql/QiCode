import type { ToolContext, ToolResult } from "../tools/types.js";
import type { AgentDefinition } from "./definition.js";
import type { SubAgentRequest, SubAgentResult, SubAgentRunner } from "./runner.js";
import { TaskManager } from "./task-manager.js";

export interface AgentToolHost {
  definitions(): readonly AgentDefinition[];
  runner(): SubAgentRunner;
  taskManager(): TaskManager;
}

/**
 * 模型看到的唯一 SubAgent 入口。它只做参数校验和路径选择，运行隔离交给 Runner，
 * 后台状态交给 TaskManager；子 Agent 永远不会因为这个工具再次获得 Agent 工具。
 */
export class AgentTool {
  readonly name = "Agent";
  readonly description = "Delegate a bounded task to one of the listed SubAgent roles. Use the exact subagent_type value; background roles return immediately with a task id.";
  readonly category = "read" as const;
  readonly system = true;

  constructor(private readonly host: AgentToolHost) {}

  schema(): Record<string, unknown> {
    const definitions = this.host.definitions();
    const roleNames = definitions.map((definition) => definition.name);
    const roleDescriptions = definitions.map((definition) =>
      `${definition.name}: ${definition.description}${definition.background ? " (background; returns a task id)" : " (foreground; waits for the result)"}`,
    );
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short task label" },
          prompt: { type: "string", description: "Bounded task for the SubAgent" },
          subagent_type: {
            type: "string",
            enum: roleNames,
            description: `Exact role name. Available roles: ${roleDescriptions.join("; ")}. Do not substitute another role.`,
          },
          model: { type: "string", description: "Optional model override" },
          operation: { type: "string", enum: ["run", "status", "cancel"] },
          task_id: { type: "string", description: "Background task id for status/cancel" },
        },
      },
    };
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const operation = stringArg(args, "operation") || "run";
    if (operation === "status") return this.status(stringArg(args, "task_id"));
    if (operation === "cancel") return this.cancel(stringArg(args, "task_id"));
    if (operation !== "run") return errorResult("operation must be run, status, or cancel");

    const description = stringArg(args, "description");
    const prompt = stringArg(args, "prompt");
    if (description === "" || prompt === "") return errorResult("description and prompt are required");

    const roleName = stringArg(args, "subagent_type") || "general-purpose";
    const definition = this.host.definitions().find((item) => item.name === roleName);
    if (definition === undefined) return errorResult(`Unknown SubAgent role: ${roleName}`);
    const model = optionalString(args, "model");
    if (args.model !== undefined && model === null) return errorResult("model must be a non-empty string");
    const modelOverride = model ?? undefined;

    const request: SubAgentRequest = {
      definition,
      prompt,
      ...(modelOverride === undefined ? {} : { modelOverride }),
    };
    if (definition.background) {
      try {
        const task = this.host.taskManager().create(description, request);
        return {
          output: `Background SubAgent task created: ${task.id} (${definition.name})`,
          isError: false,
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }

    return this.toToolResult(await this.host.runner().run(request));
  }

  private status(taskId: string): ToolResult {
    if (taskId === "") return errorResult("task_id is required for status");
    const task = this.host.taskManager().get(taskId);
    return task === undefined
      ? errorResult(`Unknown background task: ${taskId}`)
      : { output: JSON.stringify(task), isError: false };
  }

  private cancel(taskId: string): ToolResult {
    if (taskId === "") return errorResult("task_id is required for cancel");
    return this.host.taskManager().cancel(taskId)
      ? { output: `Background task cancelled: ${taskId}`, isError: false }
      : errorResult(`Background task is missing or already finished: ${taskId}`);
  }

  private toToolResult(result: SubAgentResult): ToolResult {
    if (result.error !== undefined) {
      return {
        output: result.finalText === ""
          ? `SubAgent ${result.stopReason}: ${result.error}`
          : `${result.finalText}\n\nSubAgent ${result.stopReason}: ${result.error}`,
        isError: true,
      };
    }
    return { output: result.finalText, isError: false };
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined | null {
  if (args[key] === undefined) return undefined;
  const value = stringArg(args, key);
  return value === "" ? null : value;
}

function errorResult(output: string): ToolResult {
  return { output, isError: true };
}
