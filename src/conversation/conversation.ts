import type {
  ConversationBlock,
  ConversationMessage,
  ToolResultBlock,
} from "./types.js";

export class Conversation {
  readonly #messages: ConversationMessage[] = [];

  addUserMessage(text: string): void {
    if (text.trim() === "") {
      throw new Error("User message must not be empty");
    }

    this.#messages.push({
      role: "user",
      content: [{ type: "text", text }],
    });
  }

  addAssistantMessage(content: readonly ConversationBlock[]): void {
    if (content.length === 0) {
      throw new Error("Assistant message must contain at least one block");
    }

    this.#messages.push({
      role: "assistant",
      content: content.map(cloneBlock),
    });
  }

  addToolResultsMessage(results: readonly ToolResultBlock[]): void {
    if (results.length === 0) {
      throw new Error("Tool results message must contain at least one result");
    }

    this.#messages.push({
      role: "user",
      content: results.map(cloneBlock),
    });
  }

  getMessages(): ConversationMessage[] {
    return this.#messages.map(cloneMessage);
  }

  clear(): void {
    this.#messages.length = 0;
  }

  static visibleText(message: ConversationMessage): string {
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return {
    role: message.role,
    content: message.content.map(cloneBlock),
  };
}

function cloneBlock(block: ConversationBlock): ConversationBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
        hidden: true,
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: structuredClone(block.input),
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.toolUseId,
        content: block.content,
        isError: block.isError,
      };
  }
}
