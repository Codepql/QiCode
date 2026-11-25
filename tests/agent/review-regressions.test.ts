import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { TaskDelivery } from "../../src/agent/delivery.js";
import { HookEngine } from "../../src/hooks/engine.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ReadFileTool } from "../../src/tools/read-file.js";
import { mergeRestoredContext } from "../../src/session/catalog.js";
import { rebuildFromSession, type RestoredMessage, type SessionMessage } from "../../src/session/session.js";
import type { Provider } from "../../src/llm/client.js";
import type { AgentEvent } from "../../src/agent/events.js";

describe("pre-commit review regressions", () => {
  it("keeps a passing verification attached to the revision before a post-tool hook writes", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-hook-revision-"));
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    const file = join(workDir, "sample.txt");
    writeFileSync(file, "version checked");
    const hookEngine = new HookEngine([{ event: "post_tool_use", action: { type: "command" }, reject: false, once: false, async: false, onError: "fail" }]);
    hookEngine.fire = async (event) => {
      if (event === "post_tool_use") writeFileSync(file, "modified after the check");
      return [];
    };
    const registry = new ToolRegistry();
    registry.register({ name: "Bash", category: "command", description: "verification fixture", schema: () => ({ input_schema: { type: "object" } }),
      execute: async () => ({ output: "tests passed", isError: false, metadata: { exitCode: 0 } }) });
    const conversation = new Conversation();
    conversation.addUserMessage("运行测试");
    let requests = 0;
    const provider: Provider = { config: { name: "fake", model: "fake", protocol: "openai", api_key: "", base_url: "http://unused", thinking: false }, async *stream() {
      if (++requests === 1) yield { type: "tool_call_complete", toolId: "check", toolName: "Bash", arguments: { command: "pnpm test" } };
      else yield { type: "text_delta", text: "测试已运行" };
      yield { type: "done", stopReason: "stop" };
    } };
    const agent = new Agent({ provider, conversation, registry, workDir, checker: new PermissionChecker(workDir, "bypassPermissions"), systemPrompt: "offline", trackDelivery: true, hookEngine });
    const events: AgentEvent[] = [];
    for await (const event of agent.run()) events.push(event);
    expect(events.find((event) => event.type === "delivery")).toMatchObject({ report: { status: "unverified", changedFiles: [file], verifications: [{ status: "passed", revision: 0 }] } });
  });

  it.each([
    { goal: "请只读审查，可以运行测试", commands: ["pnpm test", "pnpm run build"], executed: ["pnpm test"] },
    { goal: "修改文案，不运行测试，但允许构建", commands: ["pnpm exec vitest run", "pnpm run build"], executed: ["pnpm run build"] },
    { goal: "请只读审查，不运行测试，但运行类型检查", commands: ["node --test", "pnpm typecheck"], executed: ["pnpm typecheck"] },
  ])("limits verification commands to the requested scope: $goal", async ({ goal, commands, executed }) => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-check-scope-"));
    const registry = new ToolRegistry();
    const observed: unknown[] = [];
    registry.register({ name: "Bash", category: "command", description: "verification fixture", schema: () => ({ input_schema: { type: "object" } }),
      execute: async (args) => { observed.push(args.command); return { output: "passed", isError: false, metadata: { exitCode: 0 } }; } });
    const conversation = new Conversation();
    conversation.addUserMessage(goal);
    let requested = false;
    const provider: Provider = { config: { name: "fake", model: "fake", protocol: "openai", api_key: "", base_url: "http://unused", thinking: false }, async *stream() {
      if (!requested) {
        requested = true;
        for (const command of commands) yield { type: "tool_call_complete", toolId: command, toolName: "Bash", arguments: { command } };
      } else yield { type: "text_delta", text: "完成" };
      yield { type: "done", stopReason: "stop" };
    } };
    for await (const _ of new Agent({ provider, conversation, registry, workDir, checker: new PermissionChecker(workDir, "bypassPermissions"), systemPrompt: "offline" }).run()) { /* consume */ }
    expect(observed).toEqual(executed);
  });
  it("skips only confirmed built-in read batches and still attributes writes to the current task", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-scan-"));
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    const file = join(workDir, "sample.txt");
    const existing = join(workDir, "existing.txt");
    writeFileSync(file, "initial");
    writeFileSync(existing, "already dirty");
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.register({ name: "Probe", category: "read", description: "Third-party probe", schema: () => ({ input_schema: { type: "object" } }), execute: async () => {
      writeFileSync(file, "changed during the tool call");
      return { output: "done", isError: false };
    } });
    const conversation = new Conversation();
    conversation.addUserMessage("查看样例并处理");
    let requests = 0;
    const provider: Provider = { config: { name: "fake", model: "fake", protocol: "openai", api_key: "", base_url: "http://unused", thinking: false }, async *stream() {
      if (++requests === 1) yield { type: "tool_call_complete", toolId: "read", toolName: "ReadFile", arguments: { file_path: file } };
      else if (requests === 2) yield { type: "tool_call_complete", toolId: "probe", toolName: "Probe", arguments: {} };
      else yield { type: "text_delta", text: "样例已处理" };
      yield { type: "done", stopReason: "stop" };
    } };
    const agent = new Agent({ provider, conversation, registry, workDir, checker: new PermissionChecker(workDir, "bypassPermissions"), systemPrompt: "offline", trackDelivery: true });
    const events: AgentEvent[] = [];
    for await (const event of agent.run()) events.push(event);
    expect(events.find((event) => event.type === "tool_result" && event.toolId === "read")).toMatchObject({ isError: false });
    expect(agent.metrics.summary().spans.filter((span) => span.kind === "workspace_scan").map((span) => span.fields.source)).toEqual(["initial", "batch"]);
    expect(events.find((event) => event.type === "delivery")).toMatchObject({ report: { changedFiles: [file] } });
  });
  it("blocks commands and edits for an explicit read-only review, then reports a partial answer on stream failure", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-phase5-read-only-"));
    const conversation = new Conversation();
    conversation.addUserMessage("请只读审查当前执行链路，给出修复方案，不修改文件、不运行测试。");
    const registry = new ToolRegistry();
    let executions = 0;
    for (const [name, category] of [["Bash", "command"], ["EditFile", "write"]] as const) {
      registry.register({ name, category, description: name, schema: () => ({ input_schema: { type: "object" } }),
        execute: async () => { executions++; return { output: "unexpected", isError: false }; } });
    }
    let requests = 0;
    const provider: Provider = { config: { name: "fake", model: "fake", protocol: "openai", api_key: "", base_url: "http://unused", thinking: false }, async *stream() {
      if (++requests === 1) {
        yield { type: "tool_call_complete", toolId: "cmd", toolName: "Bash", arguments: { command: "node --test" } };
        yield { type: "tool_call_complete", toolId: "edit", toolName: "EditFile", arguments: { file_path: "sample.ts" } };
        yield { type: "done" };
      } else {
        yield { type: "text_delta", text: "已有审查结果" };
        throw new Error("offline stream failed");
      }
    } };
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, conversation, registry, workDir, checker: new PermissionChecker(workDir, "bypassPermissions"), systemPrompt: "offline", trackDelivery: true });
    for await (const event of agent.run()) events.push(event);
    expect(executions).toBe(0);
    expect(requests).toBe(2);
    expect(events.find((event) => event.type === "delivery")).toMatchObject({ report: { status: "failed", stopReason: "error", successfulTools: 0 } });
    expect(Conversation.visibleText(conversation.getMessages().at(-1)!)).toBe("已有审查结果");
  });
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
