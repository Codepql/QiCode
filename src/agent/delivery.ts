import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResult } from "../tools/types.js";
import { workspaceState } from "./workspace-state.js";
import { isChangeInspection } from "./task-intent.js";

export type DeliveryStatus = "completed" | "unverified" | "failed" | "blocked" | "cancelled" | "budget_exhausted";
export interface VerificationRecord { command: string; revision: number; status: "passed" | "failed" | "blocked"; exitCode: number | null; logPath?: string }
export interface DeliveryReport { status: DeliveryStatus; changedFiles: string[]; initialDirtyFiles: string[]; verifications: VerificationRecord[]; message: string }

export class TaskDelivery {
  revision = 0;
  readonly changedFiles = new Set<string>();
  readonly verifications: VerificationRecord[] = [];
  repairRounds = 0;
  toolCount = 0;
  denied = false;
  private successfulTools = 0;
  private reminded = false;
  private observed: Map<string, string> | undefined;
  private initialDirtyFiles: string[] = [];
  private lastFailedRevision: number | undefined;
  constructor(public goal: string, private readonly workDir: string, private readonly planMode: boolean) {}
  get readOnlyInspection(): boolean { return isChangeInspection(this.goal); }
  async initialize(): Promise<void> { if (this.readOnlyInspection) return; this.observed = await workspaceState(this.workDir); this.initialDirtyFiles = [...this.observed?.keys() ?? []]; }
  async observe(directlyEdited: Set<string>): Promise<void> {
    if (!this.observed) return;
    const current = await workspaceState(this.workDir); if (!current) return;
    const changed = new Set([...current.keys(), ...this.observed.keys()]);
    let shellChange = false;
    for (const file of changed) if (current.get(file) !== this.observed.get(file)) {
      if (!directlyEdited.has(file)) { this.changedFiles.add(file); shellChange = true; }
    }
    if (shellChange) this.revision++;
    this.observed = current;
  }
  get actionRequested(): boolean {
    return !this.readOnlyInspection && !this.planMode && !/只解释|只规划|先规划|不要修改|仅分析|explain|plan only/i.test(this.goal)
      && /修复|实现|修改|新增|添加|检查|fix\b|implement\b|update\b|add\b|build\b/i.test(this.goal);
  }
  record(name: string, args: Record<string, unknown>, result: ToolResult): void {
    this.toolCount++;
    if (result.metadata?.status === "unknown") this.denied = true;
    if (!result.isError) this.successfulTools++;
    if (/Permission denied|Rejected by Hook|not available/.test(result.output)) this.denied = true;
    if (!result.isError && (name === "EditFile" || name === "WriteFile")) {
      this.revision++; this.changedFiles.add(result.metadata?.filePath ?? String(args.file_path));
    }
    if (name === "Bash" && (args.purpose === "verification" || isVerificationCommand(String(args.command)))) {
      const code = result.metadata?.exitCode;
      const status = code === undefined || code === null ? "blocked" : result.isError || code !== 0 ? "failed" : "passed";
      this.verifications.push({ command: String(args.command), revision: this.revision, status, exitCode: code ?? null,
        ...(result.metadata?.logPath ? { logPath: result.metadata.logPath } : {}) });
      if (status === "failed" && this.revision > 0 && this.lastFailedRevision !== this.revision) { this.repairRounds++; this.lastFailedRevision = this.revision; }
    }
  }
  async continuation(): Promise<string | undefined> {
    if (!this.actionRequested || this.reminded || this.denied) return;
    const latest = this.verifications.at(-1);
    if (this.toolCount > 0 && latest?.status !== "failed" && (!this.revision || latest?.status === "passed" && latest.revision === this.revision)) return;
    this.reminded = true;
    const checks = await projectChecks(this.workDir);
    return this.toolCount === 0
      ? "用户提出的是执行请求。当前还没有仓库操作证据，请使用工具实际处理，或明确说明为何无需修改/无法执行。不要仅提供建议。"
      : `当前改动尚无最新版本的通过记录。请执行相关检查，失败后继续修复；若确实无法验证请明确阻塞原因。${checks.length ? `项目已有入口：${checks.join("；")}。命令执行仍须通过权限检查。` : "未发现项目检查脚本，使用适当的轻量检查或说明限制，不要自动安装依赖。"}`;
  }
  report(forced?: DeliveryStatus): DeliveryReport {
    const latest = this.verifications.at(-1);
    const status = forced ?? (this.denied || this.actionRequested && !this.toolCount ? "blocked" : this.toolCount > 0 && !this.successfulTools ? "failed" : latest?.status === "failed" ? "failed"
      : this.revision && (latest?.status !== "passed" || latest.revision !== this.revision) ? "unverified" : "completed");
    const labels: Record<DeliveryStatus, string> = { completed: "执行已结束；业务目标仍需核对实际结果", unverified: "已修改，但尚未取得最新改动的验证通过记录", failed: "验证失败，仍有未解决问题", blocked: "执行或验证受阻，未宣称完成", cancelled: "任务已取消，已生效的修改保留", budget_exhausted: "执行预算已用尽，可核对现场后继续" };
    return { status, changedFiles: [...this.changedFiles], initialDirtyFiles: [...this.initialDirtyFiles], verifications: [...this.verifications], message: this.readOnlyInspection && status === "completed" ? "改动查看结束" : labels[status] };
  }
}

export function isVerificationCommand(command: string): boolean {
  return /^(?:pnpm(?:\.cmd)?|npm(?:\.cmd)?)\s+(?:run\s+)?(?:test|typecheck|build|lint)(?:\s+[^;&|]*)?$/.test(command.trim())
    || /^node\s+--test(?:\s+[^;&|]*)?$/.test(command.trim());
}
export async function projectChecks(workDir: string): Promise<string[]> {
  try {
    const document: unknown = JSON.parse(await readFile(join(workDir, "package.json"), "utf8"));
    if (!document || typeof document !== "object" || !("scripts" in document) || !document.scripts || typeof document.scripts !== "object") return [];
    const scripts = document.scripts;
    return ["test", "typecheck", "build", "lint"].filter((key) => key in scripts).map((key) => `package.json scripts.${key}`);
  } catch { return []; }
}
