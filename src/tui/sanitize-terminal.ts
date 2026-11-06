const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/g;
const ANSI_STRING = /\x1B[P_X^][\s\S]*?(?:\x1B\\|$)/g;

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(ANSI_OSC, "")
    .replace(ANSI_STRING, "")
    .replace(ANSI_CSI, "")
    .replace(/\x1B(?:[ -/]*[@-~])?/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}
