import { describe, expect, it } from "vitest";
import { Conversation } from "../../src/conversation/conversation.js";
import type {
  ConversationMessage,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../../src/conversation/types.js";

describe("Conversation", () => {
  it("stores user and assistant messages in order", () => {
    const conversation = new Conversation();

    conversation.addUserMessage("Hello");
    conversation.addAssistantMessage([{ type: "text", text: "Hi" }]);

    expect(conversation.getMessages()).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ]);
  });

  it("stores thinking and text blocks in their original order", () => {
    const conversation = new Conversation();
    const thinking: ThinkingBlock = {
      type: "thinking",
      thinking: "private reasoning",
      signature: "signed-block",
      hidden: true,
    };

    conversation.addAssistantMessage([
      thinking,
      { type: "text", text: "Visible answer" },
    ]);

    expect(conversation.getMessages()[0]).toEqual({
      role: "assistant",
      content: [thinking, { type: "text", text: "Visible answer" }],
    });
  });

  it("stores assistant text, thinking, and tool calls in order", () => {
    const conversation = new Conversation();
    const thinking: ThinkingBlock = {
      type: "thinking",
      thinking: "private reasoning",
      signature: "signed-block",
      hidden: true,
    };
    const toolUse: ToolUseBlock = {
      type: "tool_use",
      id: "tool-1",
      name: "ReadFile",
      input: { file_path: "README.md" },
    };

    conversation.addAssistantMessage([
      thinking,
      { type: "text", text: "我先读取文件。" },
      toolUse,
    ]);

    expect(conversation.getMessages()[0]).toEqual({
      role: "assistant",
      content: [thinking, { type: "text", text: "我先读取文件。" }, toolUse],
    });
  });

  it("adds tool results as a user message", () => {
    const conversation = new Conversation();
    const results: ToolResultBlock[] = [
      {
        type: "tool_result",
        toolUseId: "tool-1",
        content: "1\t# QiCode",
        isError: false,
      },
    ];

    conversation.addToolResultsMessage(results);

    expect(conversation.getMessages()).toEqual([
      { role: "user", content: results },
    ]);
  });

  it("adds system reminders as a protected user message", () => {
    const conversation = new Conversation();

    conversation.addSystemReminder("Plan mode is active. Only inspect files.");

    expect(conversation.getMessages()).toEqual([
      {
        role: "user",
        content: [{
          type: "text",
          text: "<system-reminder>\nPlan mode is active. Only inspect files.\n</system-reminder>",
        }],
      },
    ]);
  });

  it("does not expose mutable tool inputs or results", () => {
    const conversation = new Conversation();
    const toolUse: ToolUseBlock = {
      type: "tool_use",
      id: "tool-1",
      name: "ReadFile",
      input: { nested: { path: "original" } },
    };
    conversation.addAssistantMessage([toolUse]);

    const firstRead = conversation.getMessages();
    const firstBlock = firstRead[0]?.content[0];
    if (firstBlock?.type === "tool_use") {
      const nested = firstBlock.input["nested"] as { path: string };
      nested.path = "mutated";
    }

    expect(conversation.getMessages()[0]?.content[0]).toEqual(toolUse);
  });

  it("returns deep copies so callers cannot mutate internal history", () => {
    const conversation = new Conversation();
    conversation.addUserMessage("Original question");

    const firstRead = conversation.getMessages();
    firstRead.push({
      role: "assistant",
      content: [{ type: "text", text: "Injected response" }],
    });
    const firstBlock = firstRead[0]?.content[0];
    if (firstBlock?.type === "text") {
      firstBlock.text = "Mutated question";
    }

    expect(conversation.getMessages()).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Original question" }],
      },
    ]);
  });

  it("does not retain mutable assistant blocks owned by the caller", () => {
    const conversation = new Conversation();
    const blocks: ConversationMessage["content"] = [
      { type: "text", text: "Original answer" },
    ];

    conversation.addAssistantMessage(blocks);
    const block = blocks[0];
    if (block?.type === "text") {
      block.text = "Changed outside";
    }

    expect(conversation.getMessages()[0]?.content).toEqual([
      { type: "text", text: "Original answer" },
    ]);
  });

  it("returns only text blocks for visible rendering", () => {
    const message: ConversationMessage = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "private reasoning",
          signature: "signed-block",
          hidden: true,
        },
        {
          type: "tool_use",
          id: "tool-1",
          name: "ReadFile",
          input: { file_path: "README.md" },
        },
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content: "hidden tool output",
          isError: false,
        },
        { type: "text", text: "First paragraph" },
        { type: "text", text: "Second paragraph" },
      ],
    };

    expect(Conversation.visibleText(message)).toBe(
      "First paragraphSecond paragraph",
    );
  });

  it("rejects empty user messages and empty assistant content", () => {
    const conversation = new Conversation();

    expect(() => conversation.addUserMessage("   ")).toThrow(
      "User message must not be empty",
    );
    expect(() => conversation.addAssistantMessage([])).toThrow(
      "Assistant message must contain at least one block",
    );
  });

  it("can clear all in-memory history", () => {
    const conversation = new Conversation();
    conversation.addUserMessage("Temporary message");

    conversation.clear();

    expect(conversation.getMessages()).toEqual([]);
  });

  it("replaces old history with a summary and cloned recent messages", () => {
    const conversation = new Conversation();
    conversation.addUserMessage("old task");
    conversation.addAssistantMessage([{ type: "text", text: "old answer" }]);
    const keep: ConversationMessage[] = [{
      role: "user",
      content: [{ type: "text", text: "recent task" }],
    }];

    conversation.replaceWithCompacted("summary", keep);
    keep[0]!.content[0] = { type: "text", text: "mutated outside" };

    expect(conversation.getMessages()).toEqual([
      { role: "user", content: [{ type: "text", text: "summary" }] },
      { role: "user", content: [{ type: "text", text: "recent task" }] },
    ]);
  });
});
