import type { ToolResult } from "../tools/types.js";
import type { HookActionExecutor, HookContext, HookResult } from "./types.js";

export const HOOK_COMMAND_TIMEOUT_SECONDS = 30;
export const HOOK_COMMAND_OUTPUT_LIMIT_BYTES = 32 * 1024;

export interface HookCommandRequest {
  command: string;
  environment: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  outputLimitBytes: number;
  context: HookContext;
}

/**
 * 命令的真实执行者由 Agent 在后续阶段提供。这个接口刻意不暴露 spawn，
 * 以便执行前统一经过 PermissionChecker、审批弹窗和取消信号。
 */
export interface HookCommandHost {
  execute(request: HookCommandRequest): Promise<ToolResult>;
}

export class HookCommandActionExecutor implements HookActionExecutor {
  constructor(private readonly host: HookCommandHost) {}

  async execute(action: Parameters<HookActionExecutor["execute"]>[0], context: HookContext): Promise<Omit<HookResult, "reject">> {
    if (action.type !== "command" || action.command === undefined) {
      return { output: `Unsupported Hook action for command executor: ${action.type}`, success: false };
    }

    const result = await this.host.execute({
      command: action.command,
      environment: hookEnvironment(context),
      timeoutSeconds: HOOK_COMMAND_TIMEOUT_SECONDS,
      outputLimitBytes: HOOK_COMMAND_OUTPUT_LIMIT_BYTES,
      context,
    });
    return {
      output: result.output.trim(),
      success: !result.isError,
    };
  }
}

function hookEnvironment(context: HookContext): NodeJS.ProcessEnv {
  return {
    QICODE_HOOK_EVENT: context.event,
    QICODE_HOOK_TOOL: context.toolName ?? "",
    QICODE_HOOK_FILE: context.filePath ?? "",
  };
}
