import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskBudget, parseExecution, withIdleTimeout } from "../../src/agent/execution.js";
import { validateToolInput } from "../../src/tools/validate.js";
import type { Tool } from "../../src/tools/types.js";
import { preciseReplace } from "../../src/tools/edit-diff.js";
afterEach(() => vi.useRealTimers());

describe("execution boundaries", () => {
  it("pauses execution time during approval while retaining external cancellation", async () => {
    vi.useFakeTimers(); const external = new AbortController(); const budget = new TaskBudget(100, external.signal);
    await vi.advanceTimersByTimeAsync(30); budget.pause(); await vi.advanceTimersByTimeAsync(2000);
    expect(budget.signal.aborted).toBe(false); budget.resume(); await vi.advanceTimersByTimeAsync(69);
    expect(budget.signal.aborted).toBe(false); await vi.advanceTimersByTimeAsync(1); expect(budget.signal.aborted).toBe(true); budget.dispose();
    const paused = new TaskBudget(100, external.signal); paused.pause(); external.abort(); expect(paused.signal.aborted).toBe(true); paused.dispose();
  });
  it("interrupts a stalled iterator even if it ignores AbortSignal", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const stream = { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<string>>(() => {}) }; } };
    const request = withIdleTimeout(stream, 50, controller, controller.signal).next();
    const assertion = expect(request).rejects.toThrow("idle timeout");
    await vi.advanceTimersByTimeAsync(50); await assertion;
  });
  it("validates nested tool args without coercing types or executing defaults", () => {
    const tool: Tool = { name: "strict", description: "test", category: "read", schema: () => ({ input_schema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false } }), execute: async () => ({ output: "", isError: false }) };
    expect(validateToolInput(tool, { count: 3 })).toBeUndefined();
    expect(validateToolInput(tool, { count: "3" })).toBeDefined();
    expect(validateToolInput(tool, {})).toBeDefined();
    expect(validateToolInput(tool, { count: 3, injected: true })).toBeDefined();
  });
  it("matches normalized CRLF/BOM while preserving unrelated mixed endings", () => {
    const result = preciseReplace("\ufefffirst\r\n中文 old\r\nlast\n", "中文 old\n", "中文 new\n", false);
    expect(result.content).toBe("\ufefffirst\r\n中文 new\r\nlast\n");
    expect(() => preciseReplace("same same", "same", "new", false)).toThrow("2 处");
  });
  it("rejects unknown or invalid execution limits", () => {
    expect(parseExecution({ maxProviderRetries: 0, maxIterations: 80 })).toEqual({ maxProviderRetries: 0, maxIterations: 80 });
    expect(() => parseExecution({ shell_secret: "hidden" })).toThrow("Invalid execution setting");
    expect(() => parseExecution({ taskTimeoutMs: 0 })).toThrow();
  });
});
