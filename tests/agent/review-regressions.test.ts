import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { TaskDelivery } from "../../src/agent/delivery.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { mergeRestoredContext } from "../../src/session/catalog.js";
import { rebuildFromSession, type RestoredMessage, type SessionMessage } from "../../src/session/session.js";
import type { Provider } from "../../src/llm/client.js";

describe("pre-commit review regressions", () => {
  it("counts several failed checks of one revision as one repair round", () => {
    const delivery = new TaskDelivery("修复功能", ".", false);
    delivery.record("EditFile", { file_path: "a.ts" }, { output: "edited", isError: false });
    for (const command of ["pnpm test", "pnpm typecheck", "pnpm build"]) delivery.record("Bash", { command, purpose: "verification" }, { output: "failed", isError: true, metadata: { exitCode: 1 } });
    expect(delivery.repairRounds).toBe(1);
    delivery.record("EditFile", { file_path: "a.ts" }, { output: "repaired", isError: false });
    delivery.record("Bash", { command: "pnpm test", purpose: "verification" }, { output: "failed", isError: true, metadata: { exitCode: 1 } });
    expect(delivery.repairRounds).toBe(2);
  });
  it("preserves Anthropic input usage when output-only usage arrives later", async () => {
    let main = 0; let summaries = 0;
    const provider: Provider = { config: { name: "fake", model: "fake", protocol: "anthropic", api_key: "unused", base_url: "http://unused", thinking: false }, async *stream(request) {
      if (request.systemPrompt.startsWith("You summarize")) { summaries++; yield { type: "text_delta", text: "Earlier context retained." }; yield { type: "done" }; return; }
      if (!main++) { yield { type: "usage", inputTokens: 25000 }; yield { type: "tool_call_complete", toolId: "read", toolName: "Probe", arguments: {} }; yield { type: "usage", outputTokens: 100 }; }
      else yield { type: "text_delta", text: "done" };
      yield { type: "done" };
    } };
    const conversation = new Conversation(); for (let i = 0; i < 8; i++) conversation.addUserMessage("context ".repeat(120));
    const registry = new ToolRegistry(); registry.register({ name: "Probe", description: "read", category: "read", schema: () => ({ input_schema: { type: "object" } }), execute: async () => ({ output: "observed", isError: false }) });
    const workDir = mkdtempSync(join(tmpdir(), "qicode-usage-anchor-"));
    for await (const _ of new Agent({ provider, conversation, registry, workDir, checker: new PermissionChecker(workDir), systemPrompt: "offline", contextWindow: 32768, maxOutput: 8192 }).run()) { /* consume */ }
    expect(summaries).toBe(1); expect(main).toBe(2);
  });
  const text = (value: string): RestoredMessage => ({ role: "user", content: [{ type: "text", text: value }] });
  it("refreshes durable/MCP blocks in place without shifting checkpoint message indices", () => {
    const durable = (body: string) => text(`<system-reminder>\nUse the following durable context when it applies.\n${body}\n</system-reminder>`);
    const mcp = (body: string) => text(`<system-reminder>\n# MCP Server: project\n${body}\n</system-reminder>`);
    const messages = [durable("old rules"), mcp("old instructions"), text("task before checkpoint"), text("task after checkpoint")];
    const once = mergeRestoredContext(messages, [durable("new rules"), mcp("new instructions")]);
    const twice = mergeRestoredContext(once, [durable("new rules"), mcp("new instructions")]);
    expect(twice).toHaveLength(4); expect(twice[2]).toEqual(messages[2]); expect(twice[3]).toEqual(messages[3]);
    expect(JSON.stringify(twice)).toContain("new rules"); expect(JSON.stringify(twice)).not.toContain("old instructions");
  });
  it("does not append another recovery reminder on each restore/save cycle", () => {
    const entry = (type: string, data: unknown): SessionMessage => ({ role: "system", type, content: JSON.stringify(data), timestamp: new Date().toISOString() });
    const delivery = entry("delivery_v2", { status: "unverified" });
    const first = rebuildFromSession([entry("messages_v2", { version: 2, start: 0, messages: [text("original")] }), delivery]);
    const second = rebuildFromSession([entry("messages_v2", { version: 2, start: 0, messages: first }), delivery]);
    expect(second).toHaveLength(first.length); expect(second[0]).toEqual(first[0]);
  });
});
