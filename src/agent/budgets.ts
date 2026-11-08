import { DEFAULT_EXECUTION, type ExecutionSettings, type ModelCapabilities } from "./execution.js";

export const CONSERVATIVE_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_OUTPUT = 8_192;
export interface EffectiveBudget {
  contextWindow: number; maxOutput: number; source: "configured" | "override" | "catalog" | "conservative";
  execution: ExecutionSettings;
}
/** Official DeepSeek V4 limits; https://api-docs.deepseek.com/news/news260424/ (2026-11-08).
 * Only use this catalog on the official endpoint. Output here is our request budget, not the server maximum.
 */
function catalogCapability(model: string, baseUrl?: string): ModelCapabilities | undefined {
  try {
    const url = new URL(baseUrl ?? "");
    if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com" || url.port) return;
    if (["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"].includes(model)) return { contextWindow: 1_048_576, maxOutput: DEFAULT_MAX_OUTPUT };
  } catch { /* Unknown endpoints keep the conservative budget. */ }
}
export function resolveBudget(model: string, capabilities: Record<string, ModelCapabilities> = {}, execution: Partial<ExecutionSettings> = {}, overrides: { contextWindow?: number; maxOutput?: number } = {}, baseUrl?: string): EffectiveBudget {
  const configured = capabilities[model];
  const catalog = catalogCapability(model, baseUrl);
  const contextWindow = overrides.contextWindow ?? configured?.contextWindow ?? catalog?.contextWindow ?? CONSERVATIVE_CONTEXT_WINDOW;
  const maxOutput = overrides.maxOutput ?? configured?.maxOutput ?? Math.min(catalog?.maxOutput ?? DEFAULT_MAX_OUTPUT, Math.max(1, Math.floor(contextWindow / 4)));
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutput) || contextWindow <= maxOutput || maxOutput <= 0) throw new Error("模型预算无效：上下文容量必须大于正整数输出预算");
  return { contextWindow, maxOutput, source: overrides.contextWindow !== undefined ? "override" : configured ? "configured" : catalog ? "catalog" : "conservative", execution: { ...DEFAULT_EXECUTION, ...execution } };
}

/** One reserve covers the requested output plus headroom; do not subtract output a second time. */
export function contextReserve(contextWindow: number, maxOutput: number): number {
  return Math.max(maxOutput, Math.min(16_384, Math.floor(contextWindow / 8)));
}
