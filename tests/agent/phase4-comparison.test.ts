import { describe, expect, it } from "vitest";
import { assessPhase4, phase4Tasks, sourceTraceChecks, type ComparisonRecord } from "../../benchmarks/phase4.js";

function records(): ComparisonRecord[] {
  return (["qicode", "pi"] as const).flatMap((agent) => phase4Tasks.flatMap((task) => [1, 2, 3].map((attempt) => ({ agent, task: task.id, attempt, mode: "live" as const,
    baseline: "frozen", conditions: "same-model-endpoint-budget", success: true, elapsedMs: attempt * 100, interventions: 0, criticalError: false,
    ...(task.id === "F01" ? { sourceChecks: Object.fromEntries(sourceTraceChecks.map((key) => [key, true])) } : {}) }))));
}
describe("phase-4 comparison gate", () => {
  it("requires all attempts and eight factual checks, without accepting offline or duplicate evidence", () => {
    const all = records(); expect(assessPhase4(all, "frozen", "same-model-endpoint-budget").status).toBe("passed");
    const missing = all.filter((_record, i) => i !== 0); missing.push(all[1]!);
    expect(assessPhase4(missing, "frozen", "same-model-endpoint-budget").status).toBe("not_passed");
    const incomplete = records(); incomplete[0]!.sourceChecks = { enter: true };
    expect(assessPhase4(incomplete, "frozen", "same-model-endpoint-budget").issues).toContain("qicode/F01: source evidence incomplete");
  });
  it("preserves critical failures and incompatible conditions even when every run says success", () => {
    const all = records(); all[0]!.criticalError = true; all[1]!.conditions = "other-model";
    const report = assessPhase4(all, "frozen", "same-model-endpoint-budget"); expect(report.status).toBe("not_passed"); expect(report.groups[0]?.medianMs).toBe(200);
    expect(report.issues.join("\n")).toContain("critical error"); expect(report.issues.join("\n")).toContain("incompatible");
    expect(assessPhase4([], "frozen", "same-model-endpoint-budget").status).toBe("not_passed");
  });
});
