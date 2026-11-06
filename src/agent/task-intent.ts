/** Narrow optimization for inspecting a diff; explicit follow-up work takes precedence. */
export function isChangeInspection(goal: string): boolean {
  const asksToInspect = /查看|看看|审阅|审查|review|explain/i.test(goal) && /更改区|改动|变更|diff|changes/i.test(goal)
    || isSourceTrace(goal);
  const asksToChange = /(?:^|请|帮我|并|然后|直接|开始|需要|顺便|同时|继续)\s*(?:修复|修改|实现|添加|删除|重构)|\b(?:fix|implement|edit|refactor)\b/im.test(goal);
  return asksToInspect && !asksToChange;
}
export function isSourceTrace(goal: string): boolean {
  return /追踪|调用链|调用关系|执行流程|数据流|trace|call graph/i.test(goal) && /源码|代码|实现|函数|\bsrc\b|source|function/i.test(goal);
}
export function inspectionReminder(goal: string): string {
  const review = /审查|审阅|review|找.*(?:问题|bug)|有没有问题|有无问题|潜在问题/i.test(goal);
  const checks = inspectionRequestsChecks(goal) ? "用户明确要求的检查可执行。" : "未请求验证，不主动跑测试、构建或 benchmark，注明未运行。";
  if (isSourceTrace(goal)) return `本轮是源码调用链分析，只读追踪，不修改文件。${checks}先建立“入口 → 请求 → 响应 → 工具 → 结果回传 → 展示”的主链，再为各节点定向查找实际函数定义与调用点。独立读取同轮提出，长文件先搜索函数再读相关行，不反复通读。输出先给主调用链，再解释关键数据转换与正常/异常结束条件，附已核对的文件位置。权限、持久化等支线仅解释影响主链的部分；缺失环节标未覆盖，不能用摘要或常识补成已确认实现。`;
  return `本轮是${review ? "代码审查" : "查看改动"}的只读请求，不修改文件。${checks}${review ? "先报告有证据的问题、位置与影响；没有明确问题就直说，不套用提升清单。" : "一句结论加 3–5 个主要变化，必要时说明限制；证据足够即结束。"}`;
}
export function inspectionRequestsChecks(goal: string): boolean { return /(?:运行|执行|跑)\s*(?:测试|检查|验证)|\b(?:run|execute)\s+(?:tests?|checks?)\b/i.test(goal); }
