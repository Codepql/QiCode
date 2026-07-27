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

export type ConversationBlock = TextBlock | ThinkingBlock;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: ConversationBlock[];
}
