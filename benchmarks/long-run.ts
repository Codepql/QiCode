/** Opt-in wall-clock regression; no network or model API. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import { Conversation } from "../src/conversation/conversation.js";
import { PermissionChecker } from "../src/permissions/checker.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { BashTool } from "../src/tools/bash.js";
import type { Provider } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";

const workDir = await mkdtemp(join(tmpdir(), "qicode-long-run-"));
await writeFile(join(workDir, "long.cjs"), "const t=setInterval(()=>console.log('progress'),10000);setTimeout(()=>{clearInterval(t);console.log('passed')},181000);");
let sent = false;
const provider: Provider = {
  config: { name: "offline", model: "scripted", protocol: "openai", api_key: "unused", base_url: "http://localhost", thinking: false },
  async *stream(): AsyncIterable<StreamEvent> {
    if (!sent) { sent = true; yield { type: "tool_call_complete", toolId: "long", toolName: "Bash", arguments: { command: "node long.cjs", timeout: 200 } }; }
    yield { type: "done" };
  },
};
const conversation = new Conversation(); conversation.addUserMessage("执行本地长命令");
const registry = new ToolRegistry(); registry.register(new BashTool());
const start = Date.now(); let updates = 0; let passed = false;
for await (const event of new Agent({ provider, conversation, registry, workDir, systemPrompt: "Offline regression", checker: new PermissionChecker(workDir, "bypassPermissions") }).run()) {
  if (event.type === "tool_update") { updates++; process.stdout.write("."); }
  if (event.type === "tool_result") passed = !event.isError && event.metadata?.exitCode === 0 && event.output.includes("passed");
}
const result = { passed: passed && updates > 1 && Date.now() - start >= 180_000, elapsedMs: Date.now() - start, updates, workDir };
await writeFile(join(workDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
