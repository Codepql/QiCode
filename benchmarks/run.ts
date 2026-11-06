import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigLayers } from "../src/config/load-config.js";
import { createProvider, type Provider } from "../src/llm/client.js";
import { fixtures } from "./tasks.js";
import { runScenario, type ScenarioResult } from "./runner.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--offline" && arg !== "--live")) throw new Error("Use --offline (no API) or explicitly --live (API costs apply)");
if (args.includes("--live") && args.includes("--offline")) throw new Error("Choose exactly one benchmark mode");
let provider: Provider | undefined;
if (args.includes("--live")) { const config = await loadConfigLayers(); provider = await createProvider(config.providers[0]!); }
const results: ScenarioResult[] = [];
for (let attempt = 1; attempt <= 3; attempt++) for (const fixture of fixtures) {
  const result = await runScenario(fixture, provider); results.push(result);
  process.stdout.write(`${attempt}/3 ${fixture.id}: ${result.success ? "PASS" : "FAIL"} (${result.elapsedMs}ms)${result.accelerated ? " [accelerated delay, not a 3-minute test]" : ""}\n`);
}
const mode = provider ? "live" : "offline-scripted";
const directory = join(process.cwd(), ".qicode", "benchmarks"); await mkdir(directory, { recursive: true });
const path = join(directory, `${mode}-${Date.now()}.json`);
await writeFile(path, JSON.stringify({ mode, model: provider?.config.model ?? "deterministic-no-LLM", note: provider ? "No pi/original-version comparison was performed." : "Offline scripted execution only; not model coding success rate. B08 uses an accelerated delay.", passed: results.filter((result) => result.success).length, total: results.length, results }, null, 2));
process.stdout.write(`Report: ${path}\n`);
if (results.some((result) => !result.success)) process.exitCode = 1;
