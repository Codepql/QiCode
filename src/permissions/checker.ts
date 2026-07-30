import type { ToolCategory } from "../tools/types.js";

export type AgentMode = "default" | "plan";

export class PermissionChecker {
  constructor(readonly mode: AgentMode = "default") {}

  allows(category: ToolCategory): boolean {
    return this.mode === "default" || category === "read";
  }
}
