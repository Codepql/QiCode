import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Conversation } from "../src/conversation/conversation.js";
import { createToolRegistry } from "../src/tui/runtime.js";
import { PermissionChecker } from "../src/permissions/checker.js";
import { buildSystemPrompt, detectEnvironment } from "../src/prompt/builder.js";
import { loadSession, newSessionId, rebuildFromSession } from "../src/session/session.js";
import { runSession } from "../src/session/run-session.js";
import { listMetrics, type RunSummary } from "../src/metrics/run-metrics.js";
import type { Provider, ChatRequest } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { TaskFixture, Step } from "./tasks.js";

const exec = promisify(execFile);
export interface ScenarioResult { id: string; mode: "offline-scripted" | "live"; success: boolean; elapsedMs: number; workDir: string; toolCalls: number; toolErrors: number; verificationFailures: number; resumed: boolean; accelerated: boolean; runs: RunSummary[]; error?: string }

class ScriptedProvider implements Provider {
  readonly config = { name: "scripted", protocol: "openai" as const, model: "deterministic-no-LLM", base_url: "http://localhost", api_key: "offline-unused-secret", thinking: false };
  private index = 0;
  constructor(private readonly steps: Step[], private readonly command: string, private readonly prefix: string) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const step = this.steps[this.index++];
    if (step) yield { type: "tool_call_complete", toolId: `${this.prefix}-${this.index}`, toolName: step.name,
      arguments: step.args.command === "$VERIFY" ? { ...step.args, command: this.command } : step.args };
    else yield { type: "text_delta", text: "已处理，请核对真实验证记录。" };
    yield { type: "done", stopReason: step ? "tool_use" : "stop" };
  }
}

export async function runScenario(fixture: TaskFixture, liveProvider?: Provider): Promise<ScenarioResult> {
  const outer = await mkdtemp(join(tmpdir(), "qicode-delivery-"));
  const workDir = join(outer, "项目 workspace"); await mkdir(workDir);
  for (const [name, content] of Object.entries(fixture.files)) { const file = join(workDir, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content, "utf8"); }
  const verifier = join(outer, "verify.cjs");
  await writeFile(verifier, `const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path'); const load=name=>require(path.resolve(process.cwd(),name));\n${fixture.verify}\n`, "utf8");
  const expectedVerifier = await readFile(verifier, "utf8");
  const command = `node "${verifier.replaceAll("\\", "/")}"`;
  const sessionId = newSessionId();
  const conversation = new Conversation();
  conversation.addUserMessage(`${fixture.prompt}\n完成修改后用 Bash 执行以下独立验收命令，purpose 填 verification：${command}\n独立验收器只读，不允许修改。`);
  const events: AgentEvent[] = [];
  const registry = createToolRegistry();
  const environment = await detectEnvironment(workDir);
  const base = { registry, workDir, sessionId, systemPrompt: buildSystemPrompt(environment), trackDelivery: true,
    checker: new PermissionChecker(workDir, "acceptEdits"), execution: { taskTimeoutMs: 60_000, maxIterations: 30, maxProviderRetries: 0 },
    onPermissionRequest: async (_tool: string, args: Record<string, unknown>) => args.command === command ? "allow" as const : "deny" as const };
  let conflict = false;
  const onToolStart = (_id: string, name: string): void => {
    if (fixture.conflict && name === "EditFile" && !conflict) { conflict = true; appendFileSync(join(workDir, "conflict.cjs"), "// external-change\n"); }
  };
  const started = Date.now();
  let resumed = false;
  let error: string | undefined;
  try {
    const firstProvider = liveProvider ?? new ScriptedProvider([...fixture.steps, { name: "Bash", args: { command: "$VERIFY", purpose: "verification" } }], command, "first");
    for await (const event of runSession({ ...base, provider: firstProvider, conversation, onToolStart })) {
      events.push(event);
      if (fixture.resume && event.type === "tool_result" && event.toolName === "EditFile" && !event.isError) { resumed = true; break; }
    }
    if (resumed) {
      const restored = new Conversation(); restored.restoreMessages(rebuildFromSession(loadSession(workDir, sessionId)));
      restored.addUserMessage(`继续完成验证，不重复已生效的修改：${command}`);
      const provider = liveProvider ?? new ScriptedProvider([{ name: "Bash", args: { command: "$VERIFY", purpose: "verification" } }], command, "resumed");
      for await (const event of runSession({ ...base, provider, conversation: restored })) events.push(event);
    }
    if (await readFile(verifier, "utf8") !== expectedVerifier) throw new Error("Independent verifier was changed");
    await exec(process.execPath, [verifier], { cwd: workDir, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const latest = events.filter((event) => event.type === "delivery").at(-1);
    if (latest?.type !== "delivery" || latest.report.status !== "completed") throw new Error("No completed delivery with current verification evidence");
    if (fixture.resume) {
      const intents = loadSession(workDir, sessionId).filter((entry) => entry.type === "tool_intent_v2").map((entry) => JSON.parse(entry.content) as { name: string });
      if (intents.filter((entry) => entry.name === "EditFile").length !== 1) throw new Error("Resume replayed a completed write");
    }
  } catch (failure) { error = failure instanceof Error ? failure.message : "Scenario failed"; }
  return { id: fixture.id, mode: liveProvider ? "live" : "offline-scripted", success: !error, elapsedMs: Date.now() - started, workDir,
    toolCalls: events.filter((event) => event.type === "tool_start").length,
    toolErrors: events.filter((event) => event.type === "tool_result" && event.isError).length,
    verificationFailures: events.filter((event) => event.type === "tool_result" && event.toolName === "Bash" && event.metadata?.exitCode !== undefined && event.metadata.exitCode !== 0).length,
    resumed, accelerated: fixture.accelerated === true, runs: listMetrics(workDir), ...(error ? { error } : {}) };
}
