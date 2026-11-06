import type { CompactBoundaryPayload } from "../session/session.js";

export type AgentEvent =
  | { type: "delivery"; report: import("./delivery.js").DeliveryReport }
  | { type: "tool_start"; toolId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_update"; toolId: string; toolName: string; output: string }
  | { type: "retry"; attempt: number; delayMs: number; message: string }
  | { type: "stream_reset" }
  | { type: "iteration_start"; iteration: number }
  | { type: "compact"; message: string; boundary?: CompactBoundaryPayload }
  | { type: "stream_text"; text: string }
  | { type: "thinking_text"; thinking: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | {
      type: "tool_use";
      toolId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolId: string;
      toolName: string;
      output: string;
      isError: boolean;
      elapsed: number;
      metadata?: import("../tools/types.js").ToolMetadata;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  | { type: "turn_complete" }
  | { type: "loop_complete"; stopReason?: string }
  | { type: "error"; message: string };
