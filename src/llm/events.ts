export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | {
      type: "thinking_complete";
      thinking: string;
      signature: string;
    }
  | { type: "tool_call_start"; toolId: string; toolName: string }
  | { type: "tool_call_delta"; toolId: string; argumentsDelta: string }
  | {
      type: "tool_call_complete";
      toolId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | ({ type: "usage" } & UsageInfo)
  | { type: "done"; stopReason?: string };
