import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { validateToolInput } from "../tools/validate.js";

interface PendingCall {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ExecutedToolCall {
  toolId: string;
  toolName: string;
  result: ToolResult;
  elapsed: number;
}

export class StreamingExecutor {
  readonly #pending: PendingCall[] = [];

  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: ToolContext,
  ) {}

  submit(
    toolId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    this.#pending.push({
      toolId,
      toolName,
      args: structuredClone(args),
    });
  }

  async collectResults(): Promise<ExecutedToolCall[]> {
    const pending = this.#pending.splice(0);
    return Promise.all(pending.map((call) => this.execute(call)));
  }

  async execute(call: PendingCall): Promise<ExecutedToolCall> {
    const startedAt = Date.now();
    const tool = this.registry.get(call.toolName);
    if (!tool) {
      return this.result(call, {
        output: `错误：未注册名为 "${call.toolName}" 的工具`,
        isError: true,
      }, startedAt);
    }

    let started = false;
    let ended = false;
    try {
      const validation = validateToolInput(tool, call.args);
      if (validation) return this.result(call, { output: `工具参数无效：${validation}`, isError: true }, startedAt);
      if (this.context.abortSignal?.aborted) return this.result(call, { output: "操作已取消，工具未执行", isError: true, metadata: { status: "cancelled" } }, startedAt);
      this.context.onToolStart?.(call.toolId, call.toolName, call.args);
      started = true;
      const result = await tool.execute(call.args, { ...this.context, onUpdate: (output) => this.context.onToolUpdate?.(call.toolId, call.toolName, output) });
      ended = true;
      this.context.onToolEnd?.(call.toolId, call.toolName, result);
      return this.result(call, result, startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: ToolResult = {
        output: ended ? `工具可能已生效，但结果保存失败；请核对现场，禁止盲目重放。${message}` : `执行工具 ${call.toolName} 时发生错误：${message}`,
        isError: true,
        ...(ended ? { metadata: { status: "unknown" as const } } : {}),
      };
      if (started && !ended) this.context.onToolEnd?.(call.toolId, call.toolName, result);
      return this.result(call, result, startedAt);
    }
  }

  private result(
    call: PendingCall,
    result: ToolResult,
    startedAt: number,
  ): ExecutedToolCall {
    return {
      toolId: call.toolId,
      toolName: call.toolName,
      result,
      elapsed: (Date.now() - startedAt) / 1000,
    };
  }
}
