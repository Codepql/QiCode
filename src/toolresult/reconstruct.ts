import { Conversation } from "../conversation/conversation.js";
import type { ConversationMessage } from "../conversation/types.js";

export function buildConversation(messages: readonly ConversationMessage[]): Conversation {
  const conversation = new Conversation();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.content.length > 0) conversation.addAssistantMessage(message.content);
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool_result");
    if (toolResults.length > 0) {
      conversation.addToolResultsMessage(toolResults);
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim() !== "") conversation.addUserMessage(text);
  }
  return conversation;
}
