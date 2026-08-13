import { describe, expect, it } from "vitest";
import { Conversation } from "../src/conversation/conversation.js";
import { computeCompactThreshold, computeKeepStartIndex, estimateMessages, forceCompact } from "../src/compact/compact.js";
import { RecoveryState } from "../src/compact/recovery.js";
import type { ChatRequest, Provider } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";

describe("context compaction", () => {
  it("calculates the automatic threshold", () => {
    expect(computeCompactThreshold(200_000, 8_192)).toBe(178_808);
  });

  it("keeps at least five recent messages", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, content: [{ type: "text" as const, text: `message ${index}` }] }));
    expect(computeKeepStartIndex(messages)).toBe(7);
  });

  it("summarizes old history and preserves recent messages", async () => {
    const conversation = new Conversation();
    for (let index = 0; index < 7; index += 1) conversation.addUserMessage(`message ${index}`);

    const result = await forceCompact(conversation, new SummaryProvider(), new RecoveryState(), ["ReadFile"]);

    expect(result.compacted).toBe(true);
    expect(result.boundary?.summary).toBe("summary of old work");
    expect(conversation.getMessages()).toHaveLength(6);
  });

  it("uses the documented character approximation", () => {
    expect(estimateMessages([{ role: "user", content: [{ type: "text", text: "1234567" }] }])).toBe(2);
  });
});

class SummaryProvider implements Provider {
  readonly config = { name: "test", protocol: "openai" as const, model: "test", base_url: "https://example.com", api_key: "", thinking: false };

  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "summary of old work" };
    yield { type: "done" };
  }
}
