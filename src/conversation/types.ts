export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
  hidden: true;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError: boolean;
  executionState?: "unknown" | "not_executed";
  evidence?: { path: string; version: string; startLine: number; endLine: number; totalLines: number };
}

export type ConversationBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: ConversationBlock[];
}
