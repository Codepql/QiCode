import { randomUUID } from "node:crypto";
import type { Provider } from "../llm/client.js";
import { endpointIdentity, recordMetrics, type RunMetrics, type SpanStatus } from "./run-metrics.js";
import { TaskBudget, withIdleTimeout } from "../agent/execution.js";
import type { EffectiveBudget } from "../agent/budgets.js";

/** Observe only metadata. The original request and stream remain unchanged. */
export function measuredProvider(provider: Provider, metrics: RunMetrics, purpose: "main" | "compaction" | "auxiliary", requestId = randomUUID(), attempt = 1, timeout?: { controller: AbortController; milliseconds: number }): Provider {
  return { config: provider.config, async *stream(request) {
    const span = metrics.start("request", { requestId, attempt, purpose, inputEstimate: Math.ceil((JSON.stringify(request.messages).length + request.systemPrompt.length + JSON.stringify(request.tools ?? []).length) / 3.5) });
    let terminal = false; let status: SpanStatus = "unknown";
    try {
      const source = timeout ? withIdleTimeout(provider.stream(request), timeout.milliseconds, timeout.controller, request.signal ?? timeout.controller.signal) : provider.stream(request);
      for await (const event of source) {
        metrics.first(span, false);
        if (event.type === "text_delta" && event.text.length) metrics.first(span, true);
        if (event.type === "usage") metrics.usage(span, event);
        if (event.type === "done") terminal = true;
        yield event;
      }
      status = terminal ? "completed" : "unknown";
    } catch (error) {
      status = timeout?.controller.signal.aborted ? "timeout" : request.signal?.aborted ? "cancelled" : "failed";
      throw error;
    } finally { metrics.end(span, request.signal?.aborted && status === "unknown" ? "cancelled" : status); }
  } };
}

/** Background memory calls get independent records; never guess their parent from the active UI task. */
export function auxiliaryProvider(provider: Provider, workDir: string, budget: EffectiveBudget): Provider {
  return { config: provider.config, async *stream(request) {
    const metrics = recordMetrics(workDir, { model: provider.config.model, protocol: provider.config.protocol, contextWindow: budget.contextWindow, maxOutput: budget.maxOutput, budgetSource: budget.source, endpointId: endpointIdentity(provider.config.base_url) });
    const task = new TaskBudget(budget.execution.taskTimeoutMs, request.signal);
    const controller = new AbortController(); const signal = AbortSignal.any([task.signal, controller.signal]);
    let outcome = "interrupted";
    try {
      for await (const event of measuredProvider(provider, metrics, "auxiliary", undefined, 1, { controller, milliseconds: budget.execution.requestIdleTimeoutMs }).stream({ ...request, signal, maxOutputTokens: Math.min(request.maxOutputTokens ?? 1024, budget.maxOutput) })) {
        if (event.type === "done") outcome = "completed";
        yield event;
      }
    } catch (error) { outcome = task.controller.signal.aborted || controller.signal.aborted ? "timeout" : task.signal.aborted ? "interrupted" : "error"; throw error; }
    finally { task.dispose(); metrics.finish(outcome); }
  } };
}
