import type { ProviderConfig } from "../config/types.js";
import type { ConversationMessage } from "../conversation/types.js";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | {
      type: "thinking_complete";
      thinking: string;
      signature: string;
    }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "done"; stopReason?: string };

export interface ChatRequest {
  systemPrompt: string;
  messages: ConversationMessage[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly config: ProviderConfig;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
}
