import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { Conversation } from "../../src/conversation/conversation.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ReadFileTool } from "../../src/tools/read-file.js";
import { PermissionChecker } from "../../src/permissions/checker.js";
import { RecoveryState } from "../../src/compact/recovery.js";
import type { Provider } from "../../src/llm/client.js";

const config = { name: "fake", model: "fake", protocol: "openai" as const, base_url: "http://localhost", api_key: "unused", thinking: false };
describe("observed read evidence", () => {
  it("records paging, overlap, repeat and changed content without stuffing the complete file into recovery", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-evidence-")); const path = join(workDir, "sample.ts");
    const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"); writeFileSync(path, original);
    let step = 0; const offsets = [0, 1, 0, 0];
    const provider: Provider = { config, async *stream() {
      if (step < offsets.length) {
        if (step === 3) writeFileSync(path, original.replace("line 1", "modified 1"));
        const index = step++; yield { type: "tool_call_complete", toolId: `r${index}`, toolName: "ReadFile", arguments: { file_path: "sample.ts", offset: offsets[index], limit: 2 } };
      } else yield { type: "text_delta", text: "done" };
      yield { type: "done" };
    } };
    const registry = new ToolRegistry(); registry.register(new ReadFileTool());
    const conversation = new Conversation(); conversation.addUserMessage("inspect sample source"); const recovery = new RecoveryState();
    const agent = new Agent({ provider, registry, conversation, systemPrompt: "test", workDir, checker: new PermissionChecker(workDir, "default"), recoveryState: recovery });
    for await (const _ of agent.run()) { /* real read tools, fake model */ }
    expect(agent.metrics.summary().reads.map((read) => read.kind)).toEqual(["new", "overlap", "repeat", "changed"]);
    expect(agent.metrics.summary().reads[0]).toMatchObject({ path: "sample.ts", startLine: 1, endLine: 2, totalLines: 20 });
    expect(recovery.buildRecoveryAttachment([])).toContain("modified 1"); expect(recovery.buildRecoveryAttachment([])).not.toContain("line 20");
    const evidence = conversation.getMessages().flatMap((message) => message.content).filter((block) => block.type === "tool_result");
    expect(evidence[0]?.evidence).toMatchObject({ path: "sample.ts", startLine: 1, endLine: 2 });
    expect(evidence[0]?.evidence?.version).not.toBe(evidence[3]?.evidence?.version);
    // Restored evidence describes observation only; it does not grant read-before-write permission.
    const repeated: Provider = { config, async *stream() { if (step++ === 4) yield { type: "tool_call_complete", toolId: "restored", toolName: "ReadFile", arguments: { file_path: "sample.ts", limit: 2 } }; yield { type: "done" }; } };
    conversation.addUserMessage("inspect again");
    const resumed = new Agent({ provider: repeated, registry, conversation, systemPrompt: "test", workDir, checker: new PermissionChecker(workDir, "default") });
    for await (const _ of resumed.run()) { /* observe */ }
    expect(resumed.metrics.summary().reads[0]?.kind).toBe("repeat");
  });
});
