export type AgentEvent =
  | { type: "iteration_start"; iteration: number }
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
