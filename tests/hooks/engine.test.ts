import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/hooks/condition.js";
import { HookEngine } from "../../src/hooks/engine.js";
import { validateHooks } from "../../src/hooks/validate.js";

describe("Hook validation and engine", () => {
  it("keeps valid rules when a neighboring configuration entry is invalid", () => {
    const result = validateHooks([
      { event: "pre_send", action: { type: "prompt", prompt: "use concise answers" } },
      { event: "not-an-event", action: { type: "prompt", prompt: "ignored" } },
    ]);

    expect(result.hooks).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      { index: 1, message: "invalid event 'not-an-event'" },
    ]);
  });

  it("normalizes Windows paths before evaluating a glob condition", () => {
    expect(evaluateCondition("file_path =* src/**/*.ts", {
      event: "pre_tool_use",
      filePath: "src\\hooks\\engine.ts",
    })).toBe(true);
  });

  it("fires a once rule once and exposes its prompt through the notification queue", async () => {
    const engine = new HookEngine([{
      id: "brief",
      event: "pre_send",
      action: { type: "prompt", prompt: "Answer briefly." },
      reject: false,
      once: true,
      async: false,
      onError: "ignore",
    }]);

    await engine.fire("pre_send");
    await engine.fire("pre_send");

    expect(engine.drainNotifications()).toEqual(["Answer briefly."]);
    expect(engine.drainNotifications()).toEqual([]);
  });

  it("stops pre-tool processing at the first rejecting rule", async () => {
    const engine = new HookEngine([
      {
        event: "pre_tool_use",
        action: { type: "prompt", prompt: "Blocked by policy" },
        reject: true,
        once: false,
        async: false,
        onError: "ignore",
      },
      {
        event: "pre_tool_use",
        action: { type: "prompt", prompt: "must not run" },
        reject: false,
        once: false,
        async: false,
        onError: "ignore",
      },
    ]);

    await expect(engine.firePreToolHooks("WriteFile", { file_path: "a.txt" }))
      .resolves.toEqual({ rejected: true, reason: "Blocked by policy" });
    expect(engine.drainNotifications()).toEqual(["Blocked by policy"]);
  });
});
