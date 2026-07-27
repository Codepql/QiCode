const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1B\][^\x07]*(?:\x07|\x1B\\)/g;

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "");
}
