export const HOOK_EVENTS = [
  "session_start",
  "session_end",
  "turn_start",
  "turn_end",
  "pre_send",
  "post_receive",
  "pre_tool_use",
  "post_tool_use",
  "shutdown",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookActionType = "command" | "prompt" | "http" | "agent";
export type HookErrorPolicy = "ignore" | "fail" | "reject";

export interface HookAction {
  type: HookActionType;
  command?: string;
  prompt?: string;
  url?: string;
  method?: string;
}

/** 一条已经过第 2 阶段校验、可由 HookEngine 执行的规则。 */
export interface HookRule {
  id?: string;
  event: HookEvent;
  condition?: string;
  action: HookAction;
  reject: boolean;
  once: boolean;
  async: boolean;
  onError: HookErrorPolicy;
}

/** Agent 派发事件时能提供的有限信息。 */
export interface HookContext {
  event: HookEvent;
  toolName?: string;
  args?: Record<string, unknown>;
  filePath?: string;
  message?: string;
  /** 仅由 HookEngine 为异步规则标记；异步动作不能停在权限弹窗等待。 */
  background?: boolean;
}

export interface HookResult {
  output: string;
  success: boolean;
  reject: boolean;
}

/** 有副作用的动作由后续阶段从外部注入，HookEngine 不拥有执行权限。 */
export interface HookActionExecutor {
  execute(action: HookAction, context: HookContext): Promise<Omit<HookResult, "reject">>;
}

export interface HookDiagnostic {
  index: number;
  id?: string;
  message: string;
}

export interface HookValidationResult {
  hooks: HookRule[];
  diagnostics: HookDiagnostic[];
}
