import { Agent, type AgentConfig } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import { redactSecrets } from "../llm/client.js";
import { saveMessage } from "./session.js";
import { resolveBudget } from "../agent/budgets.js";
import { endpointIdentity, recordMetrics } from "../metrics/run-metrics.js";
export class SessionPersistenceError extends Error {}

/** Shared lifecycle: stable messages + write-ahead tool intents and outcomes. */
export async function* runSession(config: AgentConfig & { sessionId: string }): AsyncGenerator<AgentEvent> {
  const budget = config.budget ?? resolveBudget(config.provider.config.model, {}, config.execution, { ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }), ...(config.maxOutput === undefined ? {} : { maxOutput: config.maxOutput }) }, config.provider.config.base_url);
  const metrics = config.metrics ?? recordMetrics(config.workDir, { model: config.provider.config.model, protocol: config.provider.config.protocol, contextWindow: budget.contextWindow, maxOutput: budget.maxOutput, budgetSource: budget.source, endpointId: endpointIdentity(config.provider.config.base_url) });
  let cursor = 0;
  const append = (type: string, data: unknown): void => {
    const content = JSON.stringify(data, (_key, value: unknown) => typeof value === "string" ? redactSecrets(value, [config.provider.config.api_key]) : value);
    try { saveMessage(config.workDir, config.sessionId, { role: "system", type, content, timestamp: new Date().toISOString() }); }
    catch { throw new SessionPersistenceError("会话保存失败：已生效的操作可能未完整记录，请核对磁盘后继续。"); }
  };
  const flush = (reset = false): void => {
    const messages = config.conversation.getMessages();
    if (reset || cursor > messages.length) cursor = 0;
    if (messages.length === cursor) return;
    append("messages_v2", { version: 2, start: cursor, messages: messages.slice(cursor) });
    cursor = messages.length;
  };
  try {
  append("run_start_v2", { version: 2, runId: metrics.runId, model: config.provider.config.model, protocol: config.provider.config.protocol,
    contextWindow: budget.contextWindow, maxOutput: budget.maxOutput, budgetSource: budget.source, execution: budget.execution });
  flush();
  const agent = new Agent({ ...config, budget, metrics, finishMetrics: false,
    onToolStart: (id, name, args) => {
      flush();
      append("tool_intent_v2", { id, name, args });
      config.onToolStart?.(id, name, args);
    },
    onToolEnd: (id, name, result) => {
      append("tool_outcome_v2", { id, name, result });
      config.onToolEnd?.(id, name, result);
    },
  });
    for await (const event of agent.run()) {
      if (event.type === "compact") flush(true);
      else if (event.type === "tool_result" || event.type === "turn_complete" || event.type === "loop_complete") flush();
      if (event.type === "delivery") append("delivery_v2", event.report);
      if (event.type === "loop_complete") append("run_end_v2", { stopReason: event.stopReason ?? "completed" });
      yield event;
    }
  } catch (error) { metrics.outcome = config.abortSignal?.aborted ? "interrupted" : "error"; throw error; }
  finally { try { flush(); } catch (error) { metrics.outcome = "error"; throw error; } finally { if (!config.metrics) metrics.finish(); } }
}
