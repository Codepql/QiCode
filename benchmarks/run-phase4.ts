import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freezePhase4, assessPhase4, phase4Tasks, type ComparisonRecord } from "./phase4.js";
import { fixtures } from "./tasks.js";
import { runScenario } from "./runner.js";

const args = process.argv.slice(2);
const directory = join(process.cwd(), ".qicode", "benchmarks");
let report: unknown;
if (args[0] === "--review" && args.length === 2) {
  const input = JSON.parse(await readFile(args[1]!, "utf8")) as { baseline: string; conditions: string; records: ComparisonRecord[] };
  if (typeof input.baseline !== "string" || !input.baseline || typeof input.conditions !== "string" || !input.conditions || !Array.isArray(input.records) || input.records.some((record) => !record || typeof record !== "object")) throw new Error("Expected non-empty baseline/conditions and records array");
  report = assessPhase4(input.records, input.baseline, input.conditions);
} else {
  if (args.length && !(args.length === 1 && ["--offline", "--freeze"].includes(args[0]!))) throw new Error("Use --offline, --freeze, or --review <local.json>. No live model calls are supported by this command.");
  const manifest = freezePhase4(process.cwd());
  const results = [];
  if (!args.includes("--freeze")) for (const task of phase4Tasks) {
    if (task.fixture === null) { results.push({ id: task.id, status: "pending_manual_source_review" }); continue; }
    const fixture = fixtures.find((fixture) => fixture.id === task.fixture)!;
    const result = await runScenario(fixture);
    results.push({ ...result, id: task.id, reusedFixture: fixture.id });
    process.stdout.write(`${task.id}/${fixture.id}: ${result.success ? "PASS" : "FAIL"}\n`);
    if (!result.success) process.exitCode = 1;
  }
  report = { manifest, mode: "offline-scripted", results, liveGate: "pending", terminalGate: "pending", note: "No model API or pi was invoked. F01 requires eight factual source checks. Reuses existing independent verifiers; does not replace the 30-scenario release gate." };
}
await mkdir(directory, { recursive: true });
const path = join(directory, `phase4-${Date.now()}.json`);
await writeFile(path, JSON.stringify(report, null, 2));
process.stdout.write(`Report: ${path}\n`);
