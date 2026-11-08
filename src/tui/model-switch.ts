import type { ConversationMessage } from "../conversation/types.js";
import type { ProviderConfig } from "../config/types.js";
import { resolveBudget } from "../agent/budgets.js";

/** Anthropic signed thinking belongs to its original model; conversion is explicit. */
export function modelHistoryIssue(messages: readonly ConversationMessage[], from: ProviderConfig, to: ProviderConfig): string | undefined {
  if (from.model === to.model && from.protocol === to.protocol && from.base_url === to.base_url && from.thinking === to.thinking) return;
  const pending = new Set<string>();
  for (const message of messages) for (const block of message.content) {
    if (block.type === "tool_use") pending.add(block.id);
    if (block.type === "tool_result") pending.delete(block.toolUseId);
  }
  if (pending.size) return "历史有未配对工具调用，请先恢复会话核对现场，再切换模型。";
  if (messages.some((message) => message.content.some((block) => block.type === "thinking"))) return "历史包含原模型的签名思考块。选择“转换历史”后仅移除隐藏思考块，保留可见对话和工具结果；或取消。";
}
export function withoutThinking(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => ({ ...message, content: message.content.filter((block) => block.type !== "thinking") })).filter((message) => message.content.length > 0);
}
export function modelChoiceDetail(config: ProviderConfig, capability?: { contextWindow: number; maxOutput: number }): string {
  const budget = resolveBudget(config.model, capability ? { [config.model]: capability } : {}, {}, {}, config.base_url);
  const source = budget.source === "catalog" ? "官方模型资料" : budget.source === "configured" ? "显式配置" : "未知，采用保守预算";
  return `${config.name}\n模型：${config.model}\n协议：${config.protocol}\n思考：${config.thinking ? "开启（需端点支持）" : "关闭"}\n上下文容量：${budget.contextWindow}（${source}）\n请求输出预算：${budget.maxOutput}\n切换保留可见对话；初始化失败保留原配置。切换初始化不发送 API 请求，端点兼容性在实际请求时验证。`;
}
