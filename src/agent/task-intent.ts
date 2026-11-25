/** Narrow optimization for inspecting a diff; explicit follow-up work takes precedence. */
export function isChangeInspection(goal: string): boolean {
  if (explicitReadOnly(goal)) return true;
  const asksToInspect = /查看|看看|审阅|审查|review|explain/i.test(goal) && /更改区|改动|变更|diff|changes/i.test(goal)
    || isSourceTrace(goal);
  const asksToChange = /(?:^|请|帮我|并|然后|直接|开始|需要|顺便|同时|继续)\s*(?:修复|修改|实现|添加|删除|重构)|\b(?:fix|implement|edit|refactor)\b/im.test(goal);
  return asksToInspect && !asksToChange;
}
export function explicitReadOnly(goal: string): boolean {
  return /(?:^|[，。；\s])(?:请\s*)?(?:仅|只)?\s*只读\s*(?:审查|审计|检查|查看|分析|解释|追踪|[，。；]|$)|(?:不要|不得|禁止|不允许|不)\s*(?:创建、)?\s*(?:修改|编辑|写入)\s*(?:任何|项目|源)?\s*(?:文件|代码)|\bread[- ]only\s+(?:review|audit|inspection)\b|\b(?:do not|don't)\s+(?:modify|edit|write)\s+(?:any\s+)?(?:files|code)\b/i.test(goal);
}

const verificationNames = {
  test: "测试|tests?", typecheck: "类型检查|type[ -]?checks?", build: "构建|builds?",
  lint: "代码检查|lint(?:ing)?", benchmark: "基准测试|benchmarks?", check: "检查|验证|checks?|verification",
} as const;
type VerificationRequest = keyof typeof verificationNames;
export type VerificationKind = Exclude<VerificationRequest, "check">;
const verificationTargets = `(?:${Object.values(verificationNames).join("|")})(?![a-z])`;
const verificationMatchers = (Object.keys(verificationNames) as VerificationRequest[]).map((kind) => ({
  kind, match: new RegExp(`^(?:${verificationNames[kind]})$`, "i"),
}));
const verificationJoin = /\s*(?:、|和|或|及|\band\b|\bor\b)\s*/i;
const verificationIntent = new RegExp(
  String.raw`(?:(不要|无需|不用|不得|禁止|不需要|不允许|不可以|不能|不|\bdo not|\bdon't|\bno need to)\s*(?:(?:进行|运行|执行|跑|run\b|execute\b)\s*)?|(?:运行|执行|跑|允许|可以|\brun\b|\bexecute\b)\s*)(${verificationTargets}(?:${verificationJoin.source}${verificationTargets})*)`, "gi",
);

function verificationRequests(goal: string): { allowed: Set<VerificationRequest>; denied: Set<VerificationRequest> } {
  const allowed = new Set<VerificationRequest>();
  const denied = new Set<VerificationRequest>();
  for (const match of goal.matchAll(verificationIntent)) {
    for (const target of match[2]!.split(verificationJoin)) {
      const kind = verificationMatchers.find((entry) => entry.match.test(target))?.kind;
      if (kind) (match[1] ? denied : allowed).add(kind);
    }
  }
  return { allowed, denied };
}

export function verificationProhibited(goal: string, kind?: VerificationKind): boolean {
  const { denied } = verificationRequests(goal);
  return kind ? denied.has(kind) || denied.has("check") : denied.size > 0;
}

export function verificationCommandKind(command: string): VerificationKind | undefined {
  const text = command.trim();
  if (/[;&|<>\r\n`$]/.test(text)) return;
  const script = /^(?:pnpm|npm)(?:\.cmd)?\s+(?:run\s+)?(test|typecheck|build|lint|benchmark)(?=[:\s]|$)/i.exec(text);
  if (script?.[1]) return script[1].toLowerCase() as VerificationKind;
  if (/^node(?:\.exe)?\s+--test(?:\s|$)/i.test(text)
      || /^(?:(?:pnpm(?:\.cmd)?\s+exec|npx(?:\.cmd)?)\s+)?(?:\.?[\\/])?(?:node_modules[\\/]\.bin[\\/])?(?:vitest|jest)(?:\.cmd)?(?:\s|$)/i.test(text)) return "test";
}

export function explicitMemoryRequest(goal: string): boolean {
  return /^(?:(?:请|麻烦)\s*)?(?:帮我\s*)?(?:记住|记下来|记下|保存到记忆|加入记忆)\s*\S/i.test(goal.trim())
    || /^(?:please\s+)?(?:remember\s+(?:that\b|this\b|my\b|to\b)|save\s+.+\s+(?:to|in)\s+memory\b)/i.test(goal.trim());
}

export function currentModelQuestion(goal: string): boolean {
  return /^(?:请问[，, ]*)?(?:你|这个项目|本项目|当前会话|qicode)?\s*(?:当前|现在)?\s*(?:运行时?|正在)?\s*(?:使用|用|采用|的)?\s*(?:的)?\s*(?:什么|哪个|哪种)模型[吗呢？?。!！]*$/i.test(goal.trim())
    || /^(?:请问[，, ]*)?(?:你|qicode|当前会话)?\s*(?:当前|现在)\s*(?:运行\s*)?(?:使用|用)?\s*(?:的)?模型(?:是|叫)什么[？?。]*$/i.test(goal.trim())
    || /^what model (?:are you using|is (?:currently )?running|is this (?:project|session) (?:currently )?using)[?.]*$/i.test(goal.trim());
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
export function inspectionRequestsChecks(goal: string, kind?: VerificationKind): boolean {
  const { allowed, denied } = verificationRequests(goal);
  if (denied.has("check")) return false;
  if (!kind) return [...allowed].some((entry) => !denied.has(entry));
  return !denied.has(kind) && (allowed.has(kind) || allowed.has("check") && (kind === "test" || kind === "typecheck" || kind === "lint"));
}
