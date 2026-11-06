import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render, Text } from "ink";
import { describe, expect, it, vi } from "vitest";
import { InputBox } from "../../src/tui/input-box.js";
import { TerminalFrame } from "../../src/tui/terminal-frame.js";
import { TerminalInput } from "../../src/tui/input-router.js";

describe("interactive terminal protocol", () => {
  it("positions the hardware cursor and restores raw, paste and mouse modes at unmount", async () => {
    let output = "";
    const raw = vi.fn();
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }), { isTTY: true, columns: 60, rows: 16 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: raw, ref() {}, unref() {} });
    const submit = vi.fn();
    const instance = render(<TerminalInput><TerminalFrame columns={60} rows={16} header={<Text>header</Text>} footer={<InputBox columns={60} onSubmit={submit} />}>{() => <Text>chat</Text>}</TerminalFrame></TerminalInput>, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      interactive: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      stdin.write("中文");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await instance.waitUntilRenderFlush();
      expect(output).toContain("\u001b[?2004h");
      expect(output).toContain("\u001b[?1006h");
      expect(output).toContain("\u001b[?25h");
      expect(output).toContain("\u001b[7G"); // One-based column: prompt 2 cells + CJK 4 cells + 1.
      expect(output).toContain("\u001b[1A"); // Cursor stays on the footer, not the header.
      stdin.write("\u001b[<64;"); stdin.write("1;1M");
      stdin.write("\u001b[200~text\n\u001b[201~");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(submit).not.toHaveBeenCalled();
      stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(submit.mock.calls[0]?.[0]).toBe("中文text\n");
    } finally {
      instance.unmount();
      instance.cleanup();
      stdin.destroy();
    }
    expect(raw).toHaveBeenCalledWith(false);
    expect(output).toContain("\u001b[?2004l");
    expect(output).toContain("\u001b[?1006l");
  });
});
