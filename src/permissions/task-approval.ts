import type { Decision, PermissionMode } from "./checker.js";

/** Explicit task approval covers known local coding tools, never an explicit ask/deny rule. */
export function taskApprovalEligible(toolName: string, args: Record<string, unknown>, mode: PermissionMode, decision: Decision): boolean {
  if (mode === "plan" || decision.effect === "deny" || decision.reason.startsWith("Permission rule:") || decision.reason.includes("结果未知")) return false;
  if (toolName === "EditFile" || toolName === "WriteFile") return true;
  if (toolName !== "Bash" || typeof args.command !== "string") return false;
  // These recognized operations keep their separate approval. This is not a full shell sandbox.
  return !/\bgit\b[^\r\n]*\bpush\b|\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\b[^\r\n]*\b(?:publish|deploy|install|add)\b|(?:^|[\s;&|])(?:rm|rmdir|del|erase|Remove-Item|ssh|scp|sftp|curl|wget)(?:\s|$)/i.test(args.command);
}
