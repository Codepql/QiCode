import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

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

    try {
      return this.result(call, await tool.execute(call.args, this.context), startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result(call, {
        output: `执行工具 ${call.toolName} 时发生错误：${message}`,
        isError: true,
      }, startedAt);
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
