import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../../src/conversation/types.js";
import { ChatView } from "../../src/tui/chat-view.js";
import { Activity } from "../../src/tui/activity.js";
import { Header } from "../../src/tui/header.js";
import { InputBox } from "../../src/tui/input-box.js";
import { PermissionDialog } from "../../src/tui/permission-dialog.js";
import { sanitizeTerminalText } from "../../src/tui/sanitize-terminal.js";
import { StatusBar } from "../../src/tui/status-bar.js";

describe("TUI layout", () => {
  it("renders the fixed cat header and metadata on wide terminals", () => {
    const view = render(<Header version="0.1.0" model="claude" workDir="E:\\work" columns={80} rows={24} />);
    expect(view.lastFrame()).toContain(" /\\_/\\");
    expect(view.lastFrame()).toContain("( o.o )");
    expect(view.lastFrame()).toContain(" > ^ <");
    expect(view.lastFrame()).toContain("QiCode v0.1.0");
    expect(view.lastFrame()).toContain("claude");
    expect(view.lastFrame()).not.toContain("anthropic");
  });

  it("hides the cat on narrow terminals", () => {
    const view = render(<Header version="0.1.0" model="gpt" workDir="E:\\work" columns={20} rows={6} />);
    expect(view.lastFrame()).not.toContain("/\\_/\\");
    expect(view.lastFrame()).toContain("QiCode v0.1.0");
    const frame = view.lastFrame() ?? "";
    expect(frame.split("QiCode v0.1.0")).toHaveLength(2);
  });

  it("never renders hidden thinking", () => {
    const messages: ConversationMessage[] = [{ role: "assistant", content: [
      { type: "thinking", thinking: "secret thought", signature: "sig", hidden: true },
      { type: "text", text: "visible answer" },
    ] }];
    const view = render(<ChatView messages={messages} />);
    expect(view.lastFrame()).toContain("visible answer");
    expect(view.lastFrame()).not.toContain("secret thought");
  });

  it("renders completed assistant Markdown instead of showing source markers", () => {
    const messages: ConversationMessage[] = [{ role: "assistant", content: [
      {
        type: "text",
        text: "### 1. JavaScript history\n\n* **Background**: Netscape\n* Second item",
      },
    ] }];

    const view = render(<ChatView messages={messages} />);
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("1. JavaScript history");
    expect(frame).toContain("Background: Netscape");
    expect(frame).toContain("* Second item");
    expect(frame).not.toContain("###");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("    *");
  });

  it("shows unknown usage as dashes", () => {
    const view = render(<StatusBar mode="default" />);
    expect(view.lastFrame()).toContain("default");
    expect(view.lastFrame()).toContain("-");
  });

  it("shows the active agent iteration in the activity label", () => {
    const view = render(<Activity active label="Iteration 2" startedAt={Date.now()} />);
    expect(view.lastFrame()).toContain("Iteration 2");
  });

  it("removes terminal control sequences while preserving newlines and tabs", () => {
    expect(sanitizeTerminalText("safe\u001b[31mred\u001b[0m\n\ttext\u0000")).toBe("safered\n\ttext");
  });

  it("keeps the dynamic input box inside a narrow terminal width", () => {
    const view = render(<InputBox columns={20} onSubmit={() => {}} />);
    view.stdin.write("abcdefghijklmnopqrstu");

    const lines = (view.lastFrame() ?? "").split("\n");
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(19);
    expect(view.lastFrame()).toContain(">");
    expect(view.lastFrame()).not.toMatch(/[╭╮╰╯─]/);
  });

  it("shows the active permission mode in the status bar", () => {
    const view = render(
      <StatusBar mode="acceptEdits" />,
    );
    expect(view.lastFrame()).toContain("Accept Edits on");
    expect(view.lastFrame()).toContain("shift+tab to cycle");
    view.unmount();
  });

  it("supports HITL keyboard selection and escape denial", async () => {
    const actions: string[] = [];
    const view = render(
      <PermissionDialog
        toolName="WriteFile"
        argsSummary="a.txt"
        reason="Mode: default"
        onComplete={(action) => actions.push(action)}
      />,
    );

    expect(view.lastFrame()).toContain("This command requires approval");
    view.stdin.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write("\r");
    expect(actions).toEqual(["allowAlways"]);
    view.unmount();

    const denyView = render(
      <PermissionDialog
        toolName="WriteFile"
        argsSummary="a.txt"
        reason="Mode: default"
        onComplete={(action) => actions.push(action)}
      />,
    );
    denyView.stdin.write("\u001b[B");
    denyView.stdin.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 0));
    denyView.stdin.write("\r");
    expect(actions).toEqual(["allowAlways", "deny"]);
    denyView.unmount();
  });
});
