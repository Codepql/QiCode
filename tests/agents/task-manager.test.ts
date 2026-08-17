import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { SubAgentRequest, SubAgentResult } from "../../src/agents/runner.js";
import { TaskManager } from "../../src/agents/task-manager.js";

const definition: AgentDefinition = {
  name: "background",
  description: "background",
  maxTurns: 2,
  permissionMode: "default",
  background: true,
};

describe("TaskManager", () => {
  it("limits concurrent tasks and emits each completion notification once", async () => {
    const pending: Array<{ request: SubAgentRequest; resolve(result: SubAgentResult): void }> = [];
    const manager = new TaskManager({
      maxConcurrent: 1,
      runner: {
        run: (request) => new Promise((resolve) => pending.push({ request, resolve })),
      },
    });

    const first = manager.create("first", request());
    const second = manager.create("second", request());
    await waitFor(() => pending.length === 1);
    expect(manager.get(first.id)?.status).toBe("running");
    expect(manager.get(second.id)?.status).toBe("queued");

    pending[0]!.resolve(success("first done"));
    await waitFor(() => pending.length === 2);
    expect(manager.get(first.id)?.status).toBe("completed");
    expect(manager.get(second.id)?.status).toBe("running");
    expect(manager.drainNotifications()).toEqual([
      expect.objectContaining({ taskId: first.id, status: "completed", summary: "first done" }),
    ]);
    expect(manager.drainNotifications()).toEqual([]);

    pending[1]!.resolve(success("second done"));
    await waitFor(() => manager.get(second.id)?.status === "completed");
  });

  it("propagates cancellation to the runner signal", async () => {
    let signal: AbortSignal | undefined;
    const manager = new TaskManager({
      runner: {
        run: async (request) => {
          signal = request.signal;
          await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
          return { finalText: "", stopReason: "interrupted", usage: {} };
        },
      },
    });

    const task = manager.create("cancel me", request());
    await waitFor(() => signal !== undefined);
    expect(manager.cancel(task.id)).toBe(true);
    expect(signal?.aborted).toBe(true);
    await waitFor(() => manager.get(task.id)?.status === "cancelled");
  });

  it("releases notified terminal tasks before enforcing the retained task limit", async () => {
    const manager = new TaskManager({
      maxRetainedTasks: 1,
      runner: { run: async () => success("done") },
    });
    const first = manager.create("first", request());
    await waitFor(() => manager.get(first.id)?.status === "completed");
    manager.drainNotifications();

    expect(() => manager.create("second", request())).not.toThrow();
  });

  it("limits each notification drain and leaves the remainder for a later turn", async () => {
    const manager = new TaskManager({
      maxConcurrent: 5,
      runner: { run: async () => success("done") },
    });
    for (let index = 0; index < 5; index += 1) manager.create(`task-${index}`, request());
    await waitFor(() => manager.list().every((task) => task.status === "completed"));

    expect(manager.drainNotifications()).toHaveLength(4);
    expect(manager.drainNotifications()).toHaveLength(1);
  });
});

function request(): SubAgentRequest {
  return { definition, prompt: "work" };
}

function success(finalText: string): SubAgentResult {
  return { finalText, stopReason: "completed", usage: {} };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for TaskManager state");
}
