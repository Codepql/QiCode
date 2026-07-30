import { describe, expectTypeOf, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";

describe("AgentEvent", () => {
  it("supports reporting the start of a loop iteration", () => {
    const event: AgentEvent = { type: "iteration_start", iteration: 1 };

    expectTypeOf(event.iteration).toEqualTypeOf<number>();
  });
});
