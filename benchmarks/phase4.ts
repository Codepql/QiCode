import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtures } from "./tasks.js";

export const sourceTraceChecks = ["enter", "dispatch", "request", "stream", "tools", "return", "display", "termination"] as const;
export const phase4Tasks = [{ id: "F01", fixture: null }, { id: "F02", fixture: "B01" }, { id: "F03", fixture: "B03" }, { id: "F04", fixture: "B04" }, { id: "F05", fixture: "B10" }] as const;
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function freezePhase4(workDir: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workDir, encoding: "utf8", windowsHide: true }).trim();
  const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "benchmarks", "package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.build.json")
    .split("\0").filter(Boolean).sort();
  const entries = [...new Set(files)].map((path) => { try { return [path, hash(readFileSync(join(workDir, path)))]; } catch { return [path, "deleted"]; } });
  return { version: 1 as const, commit: git("rev-parse", "HEAD"), sourceFingerprint: hash(JSON.stringify(entries)),
    fixtureFingerprint: hash(JSON.stringify(fixtures.filter((fixture) => phase4Tasks.some((task) => task.fixture === fixture.id)))),
    sourceTraceChecks, tasks: phase4Tasks, piVersion: null, conditions: null,
    note: "Fingerprint includes current source changes. pi version and live conditions must be supplied before comparable runs. Offline scripts do not establish model quality." };
}
export interface ComparisonRecord {
  agent: "qicode" | "pi"; task: string; attempt: number; mode: "live"; baseline: string; conditions: string;
  success: boolean; elapsedMs: number; interventions: number;
  criticalError: boolean; sourceChecks?: Partial<Record<typeof sourceTraceChecks[number], boolean>>;
}
/** Accept externally collected results only. This function never starts a model or changes a verifier. */
export function assessPhase4(records: readonly ComparisonRecord[], baseline: string, conditions: string) {
  const issues: string[] = []; const groups: { agent: string; task: string; passed: number; total: number; medianMs: number | null }[] = [];
  for (const agent of ["qicode", "pi"] as const) for (const task of phase4Tasks) {
    const runs = records.filter((record) => record.agent === agent && record.task === task.id);
    for (const attempt of [1, 2, 3]) if (runs.filter((run) => run.attempt === attempt).length !== 1) issues.push(`${agent}/${task.id}/${attempt}: missing or duplicate`);
    for (const run of runs) {
      if (run.mode !== "live" || run.baseline !== baseline || run.conditions !== conditions || !Number.isFinite(run.elapsedMs) || run.elapsedMs < 0 || !Number.isInteger(run.interventions) || run.interventions < 0 || typeof run.success !== "boolean" || typeof run.criticalError !== "boolean") issues.push(`${agent}/${task.id}: incompatible or incomplete record`);
      if (![1, 2, 3].includes(run.attempt)) issues.push(`${agent}/${task.id}: invalid attempt`);
      if (run.criticalError) issues.push(`${agent}/${task.id}: critical error`);
      if (task.id === "F01" && run.success && !sourceTraceChecks.every((key) => run.sourceChecks?.[key] === true)) issues.push(`${agent}/F01: source evidence incomplete`);
    }
    const passed = runs.filter((run) => run.success === true && run.criticalError === false).length;
    if (passed < 2) issues.push(`${agent}/${task.id}: fewer than 2 successful runs`);
    const times = runs.map((run) => run.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
    groups.push({ agent, task: task.id, passed, total: runs.length, medianMs: times.length === 3 ? times[1]! : null });
  }
  for (const agent of ["qicode", "pi"]) if (groups.filter((group) => group.agent === agent).reduce((sum, group) => sum + group.passed, 0) < 12) issues.push(`${agent}: fewer than 12/15 successful runs`);
  if (records.length !== 30 || records.some((record) => !phase4Tasks.some((task) => task.id === record.task) || !["qicode", "pi"].includes(record.agent))) issues.push("Expected exactly 30 records for the frozen five-task comparison");
  return { status: issues.length ? "not_passed" : "passed", groups, issues, note: "Small comparison only; not the phase-2 production release gate. Costs remain unknown without trusted pricing." };
}
