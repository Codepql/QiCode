import { describe, expect, it } from "vitest";
import { fixtures } from "../../benchmarks/tasks.js";
import { runScenario } from "../../benchmarks/runner.js";

describe("real local tools and independent delivery checks (no model API)", () => {
  it.each(fixtures)("executes $id through the actual Agent, file and process tools", async (fixture) => {
    const result = await runScenario(fixture);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, mode: "offline-scripted" });
    if (fixture.id === "B04") expect(result.verificationFailures).toBeGreaterThan(0);
    if (fixture.id === "B09") expect(result.toolErrors).toBeGreaterThan(0);
    if (fixture.id === "B10") expect(result.resumed).toBe(true);
  }, 20_000);
});
