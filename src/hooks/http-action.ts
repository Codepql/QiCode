import type { ToolResult } from "../tools/types.js";
import type { HookActionExecutor, HookContext, HookResult } from "./types.js";

export const HOOK_HTTP_TIMEOUT_MS = 10_000;
export const HOOK_HTTP_RESPONSE_LIMIT_BYTES = 32 * 1024;

export interface HookHttpRequest {
  url: string;
  method: string;
  body: string;
  timeoutMs: number;
  responseLimitBytes: number;
  context: HookContext;
}

/** 第六阶段由 Agent 注入，确保 HTTP Hook 先经过 PermissionChecker。 */
export interface HookHttpHost {
  execute(request: HookHttpRequest): Promise<ToolResult>;
}

export class HookHttpActionExecutor implements HookActionExecutor {
  constructor(private readonly host: HookHttpHost) {}

  async execute(action: Parameters<HookActionExecutor["execute"]>[0], context: HookContext): Promise<Omit<HookResult, "reject">> {
    if (action.type !== "http" || action.url === undefined) {
      return { output: `Unsupported Hook action for HTTP executor: ${action.type}`, success: false };
    }

    const result = await this.host.execute({
      url: action.url,
      method: action.method ?? "POST",
      body: JSON.stringify(serializeContext(context)),
      timeoutMs: HOOK_HTTP_TIMEOUT_MS,
      responseLimitBytes: HOOK_HTTP_RESPONSE_LIMIT_BYTES,
      context,
    });
    return { output: result.output.trim(), success: !result.isError };
  }
}

function serializeContext(context: HookContext): Record<string, unknown> {
  return {
    event: context.event,
    ...(context.toolName === undefined ? {} : { toolName: context.toolName }),
    ...(context.filePath === undefined ? {} : { filePath: context.filePath }),
    ...(context.message === undefined ? {} : { message: context.message }),
  };
}
