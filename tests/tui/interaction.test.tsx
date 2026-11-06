import React, { useState } from "react";
import { render, cleanup } from "ink-testing-library";
import { Text } from "ink";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBox } from "../../src/tui/input-box.js";
import { ChatView } from "../../src/tui/chat-view.js";
import { PermissionDialog } from "../../src/tui/permission-dialog.js";
import { TerminalInput, useRoutedInput } from "../../src/tui/input-router.js";
import { TerminalFrame } from "../../src/tui/terminal-frame.js";
import { App } from "../../src/tui/app.js";
import type { ConversationMessage } from "../../src/conversation/types.js";

afterEach(cleanup);
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const longMessage: ConversationMessage = { role: "assistant", content: [{ type: "text", text: Array.from({ length: 500 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n") }] };

describe("first-phase terminal interactions", () => {
  it("edits multiline drafts and sends whitespace exactly once", async () => {
    const submit = vi.fn();
    const view = render(<InputBox onSubmit={submit} />);
    view.stdin.write("  中文👨‍👩‍👧‍👦");
    view.stdin.write("\n"); // Ctrl+J, distinct from Enter/CR.
    view.stdin.write("    code");
    await tick();
    expect(submit).not.toHaveBeenCalled();
    view.stdin.write("\r");
    expect(submit).toHaveBeenCalledExactlyOnceWith("  中文👨‍👩‍👧‍👦\n    code", { literal: false });
    view.stdin.write("\r");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("assembles fragmented bracketed pastes without executing embedded keys or commands", async () => {
    const submit = vi.fn();
    const global = vi.fn();
    function Global() { useRoutedInput(0, global); return null; }
    const view = render(<TerminalInput><Global /><InputBox onSubmit={submit} /></TerminalInput>);
    view.stdin.write("\u001b[20");
    view.stdin.write("0~/exit\r\n  code\n\u0003");
    view.stdin.write("\u001b[201~");
    await tick();
    expect(submit).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain("/exit");
    view.stdin.write("\r");
    expect(submit).toHaveBeenCalledExactlyOnceWith("/exit\n  code\n", { literal: true });
  });

  it("keeps large paste content while showing a bounded summary and supports manual paste mode", async () => {
    const submit = vi.fn();
    const view = render(<InputBox columns={60} maxRows={3} onSubmit={submit} />);
    const text = "  行\r\n".repeat(1000);
    view.stdin.write(`\u001b[200~${text}\u001b[201~`);
    await tick();
    expect(view.lastFrame()).toContain("粘贴 #1");
    expect((view.lastFrame() ?? "").split("\n").length).toBeLessThan(7);
    view.stdin.write("\r");
    expect(submit.mock.calls[0]?.[0]).toBe(text.replaceAll("\r\n", "\n"));
    view.stdin.write("\u0016");
    view.stdin.write("first"); view.stdin.write("\r"); view.stdin.write("second");
    expect(submit).toHaveBeenCalledTimes(1);
    view.stdin.write("\u0016"); view.stdin.write("\r");
    expect(submit.mock.calls[1]?.[0]).toBe("first\nsecond");
  });

  it("scrolls command candidates with the selection and leaves transcript navigation alone", async () => {
    const commands = Array.from({ length: 30 }, (_, i) => ({ name: `command-${String(i).padStart(2, "0")}`, aliases: [], type: "local" as const, description: "command", handler: () => "" }));
    const submit = vi.fn();
    const view = render(<TerminalInput><ChatView messages={[longMessage]} maxHeight={5} /><InputBox commands={commands} maxSuggestions={4} onSubmit={submit} /></TerminalInput>);
    view.stdin.write("/"); await tick();
    for (let i = 0; i < 12; i++) view.stdin.write("\u001b[B");
    await tick();
    expect(view.lastFrame()).toContain("/command-12");
    expect(view.lastFrame()).toContain("line-499");
    view.stdin.write("\t"); view.stdin.write("\r");
    expect(submit.mock.calls[0]?.[0]).toBe("/command-12 ");
  });

  it("isolates modal keys and pastes, restoring the original draft on close", async () => {
    const submit = vi.fn();
    const global = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      useRoutedInput(0, (input, key) => { if (key.ctrl && input === "t") { setOpen(true); return true; } global(); return false; });
      return <><ChatView messages={[longMessage]} maxHeight={5} active={!open} />
        {open && <PermissionDialog toolName="EditFile" argsSummary="a.txt" reason="test" onComplete={() => setOpen(false)} />}
        <InputBox disabled={open} onSubmit={submit} /></>;
    }
    const view = render(<TerminalInput><Example /></TerminalInput>);
    view.stdin.write("草稿"); view.stdin.write("\u0014"); await tick();
    view.stdin.write("\u001b[A"); view.stdin.write("\u001b[5~"); view.stdin.write("x");
    view.stdin.write("\u001b[200~\r\u0003\u001b[201~");
    await tick();
    expect(submit).not.toHaveBeenCalled(); expect(global).not.toHaveBeenCalled();
    view.stdin.write("\u001b"); await new Promise((resolve) => setTimeout(resolve, 80));
    view.stdin.write("\r");
    expect(submit.mock.calls[0]?.[0]).toBe("草稿");
  });

  it("visits every row of a single long response and holds a reading anchor across updates and width changes", async () => {
    const view = render(<ChatView messages={[longMessage]} maxHeight={7} columns={30} />);
    expect((view.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(7);
    view.stdin.write("\u001b[1;5H"); await tick();
    expect(view.lastFrame()).toContain("line-000");
    const seen = new Set<string>();
    for (let page = 0; page < 110; page++) {
      for (const match of (view.lastFrame() ?? "").matchAll(/line-(\d{3})/g)) seen.add(match[1]!);
      view.stdin.write("\u001b[6~"); await tick();
    }
    expect(seen.size).toBe(500);
    view.stdin.write("\u001b[5~"); await tick();
    const anchor = /line-\d{3}/.exec(view.lastFrame() ?? "")?.[0];
    view.rerender(<ChatView messages={[longMessage]} streamingText="new output" maxHeight={7} columns={20} />); await tick();
    expect(view.lastFrame()).toContain(anchor);
    expect(view.lastFrame()).not.toContain("new output");
    view.stdin.write("\u001b[1;5F"); await tick();
    expect(view.lastFrame()).toContain("new output");
  });

  it("restores the unsent draft after browsing input history", async () => {
    const submit = vi.fn();
    const view = render(<InputBox onSubmit={submit} />);
    view.stdin.write("old"); view.stdin.write("\r"); view.stdin.write("draft");
    view.stdin.write("\u001b[A"); await tick(); expect(view.lastFrame()).toContain("old");
    view.stdin.write("\u001b[B"); await tick(); expect(view.lastFrame()).toContain("draft");
    view.stdin.write("\r"); expect(submit.mock.calls[1]?.[0]).toBe("draft");
  });

  it("keeps measured layout bounded and preserves drafts across resize", async () => {
    function Frame() { return <TerminalFrame columns={60} rows={16} header={<Text>Header</Text>} footer={<InputBox columns={60} maxRows={3} onSubmit={() => {}} />}>{(height) => <ChatView messages={[longMessage]} maxHeight={height} columns={59} />}</TerminalFrame>; }
    const view = render(<Frame />); await tick();
    expect((view.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(15);
    view.stdin.write("中文草稿"); await tick();
    for (const [columns, rows] of [[120, 40], [80, 24], [60, 16], [40, 10]]) {
      Object.defineProperty(view.stdout, "columns", { configurable: true, get: () => columns });
      Object.defineProperty(view.stdout, "rows", { configurable: true, get: () => rows });
      view.stdout.emit("resize"); await tick();
      expect(view.lastFrame()).toContain("中文草稿");
    }
  });

  it("preserves the app draft in tiny-terminal mode and refuses hidden actions", async () => {
    const view = render(<App providers={[{ name: "test", protocol: "openai", model: "fake", base_url: "http://localhost", api_key: "test", thinking: false }]} runtimeFactory={async () => ({ provider: { config: { name: "test", protocol: "openai", model: "fake", base_url: "http://localhost", api_key: "test", thinking: false }, async *stream() { yield { type: "done" as const }; } }, systemPrompt: "test" })} />);
    view.stdin.write("unsent draft"); await tick();
    Object.defineProperty(view.stdout, "columns", { configurable: true, get: () => 30 });
    Object.defineProperty(view.stdout, "rows", { configurable: true, get: () => 8 });
    view.stdout.emit("resize"); await tick();
    expect(view.lastFrame()).toContain("终端至少需要");
    view.stdin.write("\r");
    Object.defineProperty(view.stdout, "columns", { configurable: true, get: () => 80 });
    Object.defineProperty(view.stdout, "rows", { configurable: true, get: () => 24 });
    view.stdout.emit("resize"); await tick();
    expect(view.lastFrame()).toContain("unsent draft");
  });

  it("keeps consecutive real permission requests operable in a 40×10 app without background shortcuts", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-ux-permission-"));
    const config = { name: "test", protocol: "openai" as const, model: "fake", base_url: "http://localhost", api_key: "test", thinking: false };
    let turn = 0;
    const view = render(<App providers={[config]} workDir={workDir} runtimeFactory={async () => ({
      systemPrompt: "test", provider: { config, async *stream() {
        turn += 1;
        if (turn <= 2) yield { type: "tool_call_complete" as const, toolId: `write-${turn}`, toolName: "WriteFile", arguments: { file_path: `${turn}.txt`, content: "ok" } };
        else yield { type: "text_delta" as const, text: "done" };
        yield { type: "done" as const };
      } },
    })} />);
    Object.defineProperty(view.stdout, "columns", { configurable: true, get: () => 40 });
    Object.defineProperty(view.stdout, "rows", { configurable: true, get: () => 10 });
    view.stdout.emit("resize"); await tick();
    view.stdin.write("write files"); view.stdin.write("\r");
    for (let i = 0; i < 30 && !view.lastFrame()?.includes("1.txt"); i++) await tick();
    expect(view.lastFrame()).toContain("需要授权");
    expect((view.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(9);
    view.stdin.write("\u0014"); view.stdin.write("\u001b[Z");
    view.stdin.write("\u001b[200~\r\u001b[201~"); await tick();
    expect(view.lastFrame()).not.toContain("团队任务");
    expect(view.lastFrame()).toContain("default");
    view.stdin.write("\u001b"); await new Promise((resolve) => setTimeout(resolve, 80));
    for (let i = 0; i < 30 && !view.lastFrame()?.includes("2.txt"); i++) await tick();
    expect(view.lastFrame()).toContain("2.txt");
    view.stdin.write("\r");
    for (let i = 0; i < 30 && !view.lastFrame()?.includes("done"); i++) await tick();
    expect(readFileSync(join(workDir, "2.txt"), "utf8")).toBe("ok");
  });
});
