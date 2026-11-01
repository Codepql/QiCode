import { Agent, type AgentConfig } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import type { FileHistory } from "../filehistory/filehistory.js";
import type { ProviderConfig } from "../config/types.js";
import { Conversation } from "../conversation/conversation.js";
import { createProvider, redactSecrets, type Provider } from "../llm/client.js";
import type { UsageInfo } from "../llm/events.js";
import { PermissionChecker } from "../permissions/checker.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createSubAgentToolRegistry } from "./tool-filter.js";
import {
  MAX_SUBAGENT_MAX_TURNS,
  type AgentDefinition,
} from "./definition.js";

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
export const DEFAULT_SUBAGENT_OUTPUT_LIMIT_CHARS = 32_000;

export type SubAgentStopReason =
  | "completed"
  | "interrupted"
  | "timeout"
  | "output_limit"
  | "error"
  | "max_iterations"
  | "context_too_long"
  | "unknown_tool";

export type SubAgentProgressEvent = Extract<
  AgentEvent,
  { type: "iteration_start" | "tool_use" | "tool_result" | "turn_complete" | "loop_complete" }
>;

export interface SubAgentRequest {
  definition: AgentDefinition;
  prompt: string;
  modelOverride?: string;
  signal?: AbortSignal;
  onProgress?: (event: SubAgentProgressEvent) => void;
}

export interface SubAgentResult {
  finalText: string;
  stopReason: SubAgentStopReason;
  usage: UsageInfo;
  error?: string;
}

export interface SubAgentRunnerConfig {
  providerConfig: ProviderConfig;
  registry: ToolRegistry;
  systemPrompt: string;
  workDir: string;
  providerFactory?: (config: ProviderConfig) => Promise<Provider>;
  timeoutMs?: number;
  maxOutputChars?: number;
  contextWindow?: number;
  onPermissionRequest?: AgentConfig["onPermissionRequest"];
  fileHistory?: FileHistory;
}

/**
 * 一次性子 Agent 的运行边界。它只继承父 Provider 的连接配置和工作目录；
 * Conversation、PermissionChecker、AbortController、usage 都在每次 run() 中重新创建。
 */
export class SubAgentRunner {
  readonly #providerFactory: (config: ProviderConfig) => Promise<Provider>;
  readonly #timeoutMs: number;
  readonly #maxOutputChars: number;

  constructor(private readonly config: SubAgentRunnerConfig) {
    this.#providerFactory = config.providerFactory ?? createProvider;
    this.#timeoutMs = positiveLimit(
      config.timeoutMs,
      DEFAULT_SUBAGENT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxOutputChars = positiveLimit(
      config.maxOutputChars,
      DEFAULT_SUBAGENT_OUTPUT_LIMIT_CHARS,
      "maxOutputChars",
    );
  }

  async run(request: SubAgentRequest): Promise<SubAgentResult> {
    const model = resolveModel(this.config.providerConfig.model, request.definition, request.modelOverride);
    if (model === null) return failure("error", "SubAgent model must be a non-empty string");

    const controller = new AbortController();
    let externallyCancelled = false;
    const abortFromParent = (): void => {
      externallyCancelled = true;
      controller.abort();
    };
    if (request.signal?.aborted) abortFromParent();
    else request.signal?.addEventListener("abort", abortFromParent, { once: true });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    let outputLimitReached = false;
    let finalText = "";
    let stopReason: SubAgentStopReason = "completed";
    let error = "";
    const usage: UsageInfo = {};

    try {
      const provider = await this.#providerFactory({
        ...this.config.providerConfig,
        model,
      });
      if (controller.signal.aborted) {
        return failure(externallyCancelled ? "interrupted" : "timeout", "SubAgent was cancelled before start");
      }

      const conversation = new Conversation();
      if (request.definition.initialPrompt !== undefined) {
        conversation.addSystemReminder(request.definition.initialPrompt);
      }
      conversation.addUserMessage(request.prompt);
      const agent = new Agent({
        provider,
        registry: createSubAgentToolRegistry(this.config.registry, request.definition),
        conversation,
        systemPrompt: request.definition.systemPromptOverride ?? this.config.systemPrompt,
        workDir: this.config.workDir,
        abortSignal: controller.signal,
        maxIterations: Math.min(request.definition.maxTurns, MAX_SUBAGENT_MAX_TURNS),
        checker: new PermissionChecker(this.config.workDir, request.definition.permissionMode),
        ...(this.config.fileHistory === undefined ? {} : { fileHistory: this.config.fileHistory }),
        ...(this.config.contextWindow === undefined ? {} : { contextWindow: this.config.contextWindow }),
        ...(this.config.onPermissionRequest === undefined
          ? {}
          : { onPermissionRequest: this.config.onPermissionRequest }),
      });

      for await (const event of agent.run()) {
        if (event.type === "stream_text") {
          finalText = truncate(finalText + event.text, this.#maxOutputChars);
          if (finalText.length >= this.#maxOutputChars) {
            outputLimitReached = true;
            controller.abort();
            break;
          }
          continue;
        }
        if (event.type === "usage") mergeUsage(usage, event);
        if (event.type === "error") error = this.safeError(event.message);
        if (event.type === "loop_complete") {
          stopReason = toStopReason(event.stopReason);
        }
        if (isProgressEvent(event)) request.onProgress?.(event);
      }
    } catch (caught) {
      error = this.safeError(caught instanceof Error ? caught.message : String(caught));
      stopReason = "error";
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromParent);
    }

    if (outputLimitReached) {
      return { finalText, stopReason: "output_limit", usage, error: "SubAgent output exceeded the limit" };
    }
    if (timedOut) return { finalText, stopReason: "timeout", usage, error: "SubAgent timed out" };
    if (externallyCancelled) return { finalText, stopReason: "interrupted", usage };
    return error === ""
      ? { finalText, stopReason, usage }
      : { finalText, stopReason, usage, error };
  }

  private safeError(message: string): string {
    return redactSecrets(message, [this.config.providerConfig.api_key]);
  }
}

function resolveModel(
  inheritedModel: string,
  definition: AgentDefinition,
  modelOverride: string | undefined,
): string | null {
  const candidate = modelOverride ?? definition.model ?? inheritedModel;
  return candidate.trim() === "" ? null : candidate.trim();
}

function mergeUsage(target: UsageInfo, event: UsageInfo): void {
  if (event.inputTokens !== undefined) target.inputTokens = event.inputTokens;
  if (event.outputTokens !== undefined) target.outputTokens = event.outputTokens;
  if (event.cacheReadInputTokens !== undefined) target.cacheReadInputTokens = event.cacheReadInputTokens;
  if (event.cacheCreationInputTokens !== undefined) {
    target.cacheCreationInputTokens = event.cacheCreationInputTokens;
  }
}

function isProgressEvent(event: AgentEvent): event is SubAgentProgressEvent {
  return event.type === "iteration_start"
    || event.type === "tool_use"
    || event.type === "tool_result"
    || event.type === "turn_complete"
    || event.type === "loop_complete";
}

function toStopReason(reason: string | undefined): SubAgentStopReason {
  if (reason === "interrupted" || reason === "max_iterations" || reason === "context_too_long" || reason === "unknown_tool") {
    return reason;
  }
  return "completed";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function failure(stopReason: SubAgentStopReason, error: string): SubAgentResult {
  return { finalText: "", stopReason, usage: {}, error };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return limit;
}
