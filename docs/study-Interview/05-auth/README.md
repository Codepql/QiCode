# 05-Permissions Interview 学习文档：把"自主"讲成"护栏内自主"

> 本文基于第 05 章当前代码。`pnpm.cmd typecheck` 通过；当前完整验证记录为 26 个测试文件、142 个用例通过。真实终端的 HITL 交互、manual 模式下的真实风险按 Debug 文档实验验证。

## 1. 30 秒项目介绍

```text
QiCode 是一个用 TypeScript 写的终端 Coding Agent。第 05 章解决的是"工具执行没有闸门"的问题：模型输出工具调用只是一个执行意图，不等于系统授权。

我在 Agent 真正执行工具之前插入一条按优先级短路的权限流水线：安全只读命令自动放行、危险命令黑名单硬拦截、文件类工具走真实路径沙箱、三级 YAML 规则引擎、四档权限模式矩阵兜底。被拒绝的工具调用会变成结构化错误结果回灌给模型，让它换路径继续；拿不准的操作走人在回路，弹窗三选一：允许本次、永久允许、拒绝。
```

## 2. 两分钟讲法

```text
问题是三层：第一，模型会误判、提示词会被绕过，所以不能只靠软约束；第二，危险不只是"明显恶意"，`rm -rf /` 是黑名单问题，`WriteFile /etc/passwd` 是路径问题，`npm install` 是"需要确认"的问题；第三，拒绝不能中断整个 Agent，否则模型无法自我修正。

我的方案是一条 7 层流水线，每层命中就短路。第 0 层保留计划文件防御性豁免，但当前最终语义是 Plan Mode 只读，模型不会看到写工具；第 2 层安全只读命令（先查 shell 元字符，再前缀匹配，防 `cat > /etc/shadow` 这类白名单陷阱）；第 3 层危险命令黑名单，14 条内置、任何模式都拦；第 4 层路径沙箱，把目标解析成真实路径再和允许根比对，拦 `../`、前缀碰撞和符号链接逃逸；第 4b 层会话级放行；第 5 层三级 YAML 规则，现读现匹配；第 6 层四档模式矩阵做兜底，只产 allow 或 ask、绝不产 deny。

接入点很关键：检查发生在 executor.submit 之前。deny 会包成结构化错误结果回灌给模型，Ask 通过一个 Promise 回调暂停 Agent、弹窗让用户三选一，选完 Promise resolve、Agent 继续。整个过程和具体大模型协议无关——Anthropic 和 OpenAI 进入 Agent 后都是统一的 tool_use。

我诚实说明边界：Bash 不走路径沙箱，因为静态解析 shell 命令不可靠；危险命令黑名单是启发式而不是完备保证；切到 manual 模式等于用户主动放弃自动拦截。
```

## 3. 面试架构图

```text
tool_use(toolName, args)
  -> PermissionChecker.check()            src/permissions/checker.ts:383
       L0 plan 文件豁免   -> allow
       L2 安全只读命令    -> allow        src/permissions/checker.ts:399
       L3 危险黑名单      -> deny         src/permissions/checker.ts:404
       L4 路径沙箱        -> deny         src/permissions/checker.ts:415
       L4b 会话放行       -> allow
       L5 规则引擎        -> allow|deny   src/permissions/checker.ts:427
       L6 模式矩阵        -> allow|ask    src/permissions/checker.ts:433
  -> Agent.executeBatch                    src/agent/agent.ts:228
       deny  -> 结构化错误 tool_result 回灌
       ask   -> await onPermissionRequest -> App Promise 桥 -> PermissionDialog
       allow -> executor.submit -> 工具执行
```

讲图时强调：**流水线是 ordered policy，不是权重投票**；硬安全（黑名单/沙箱）先决策，用户规则居中，模式矩阵只做兜底；Deny 是一次执行失败结果，Ask 是一种暂停中的正常状态。

## 4. 高频问题

### Q1. 为什么模型输出 tool call 不等于获得执行授权？

**关键词**：意图、副作用、护栏。

```text
模型只是"建议"调用工具。LLM 会误判、提示词可被诱导、仓库内容可能不可信；真实副作用（写文件、跑命令）必须由代码在边界处把关。
```

证据：[agent.ts](../../../../src/agent/agent.ts:241)。

### Q2. 为什么权限检查必须紧贴 executor.submit()？

**关键词**：真实执行边界、单一入口。

```text
工具暴露过滤是软约束，提示词是软约束；唯一可靠的拦截点是在工具真正提交执行之前。我在 executeBatch 循环里先 check()，deny/ask 都不会走到 submit。
```

证据：[agent.ts](../../../../src/agent/agent.ts:241) 与 [agent.ts](../../../../src/agent/agent.ts:290)。

### Q3. Allow / Deny / Ask 三态怎么用？

**关键词**：自动执行、拒绝回灌、暂停等人。

```text
allow 直接提交；deny 包成 isError 的 tool_result 回灌给模型，Loop 不中断；ask 通过 onPermissionRequest 暂停，等用户决定后恢复。
```

证据：[agent.ts](../../../../src/agent/agent.ts:248)（deny）、[agent.ts](../../../../src/agent/agent.ts:270)（ask）。

### Q4. 为什么模式矩阵只做兜底、永不产 deny？

**关键词**：deny 来源唯一、矩阵是默认值。

```text
deny 必须来自明确的硬策略：黑名单、沙箱、显式 deny 规则或用户拒绝。模式矩阵只是"自动策略没结论时"的默认值，只给 allow/ask，避免默认值悄悄吞掉本该拦截的操作。
```

证据：[checker.ts](../../../../src/permissions/checker.ts:66)（`modeDecide` 只产 allow/ask）。

### Q5. 为什么 manual（全放行）也拦不住危险命令和路径沙箱？

**关键词**：不可绕过、优先级。

```text
黑名单和沙箱在 Layer 3/4，模式矩阵在 Layer 6，短路顺序决定了 manual 只能影响矩阵，碰不到更高优先级的硬拦截。
```

证据：[checker.ts](../../../../src/permissions/checker.ts:404)（黑名单先于矩阵）。

### Q6. 安全命令前缀匹配为什么要先查 shell 元字符？

**关键词**：白名单陷阱、元字符筛查。

```text
`cat` 是安全的，但 `cat /etc/passwd > /etc/shadow` 不是。如果只按前缀放行，重定向/管道/命令替换就能绕过白名单。所以 `isSafeCommand` 先扫 `> | ; & $( ` 等元字符，再匹配前缀。
```

证据：[checker.ts](../../../../src/permissions/checker.ts:163) 与 [checker.ts](../../../../src/permissions/checker.ts:157)。

### Q7. 为什么 startsWith(workDir) 不是可靠沙箱？

**关键词**：前缀碰撞、真实路径、符号链接。

```text
`/a/b` 会误放 `/a/bc`；相对路径和 `../` 需要 resolve；软链能指向项目外。PathSandbox 用 resolve + relative + 最近存在祖先的 realpath 三层校验，新文件也通过真实父目录验证。
```

证据：[checker.ts](../../../../src/permissions/checker.ts:230) 与 [checker.ts](../../../../src/permissions/checker.ts:191)。

### Q8. 损坏 YAML 为什么降级为空规则，而不是全 Allow？

**关键词**：fail-safe、不放大权限。

```text
解析失败意味着"不知道用户意图"，此时最安全的是当作没有规则，继续走后续模式矩阵；绝不能因为解析失败变成全放行。loadRulesFile 对 5 类异常全部静默降级为空数组。
```

证据：[checker.ts](../../../../src/permissions/checker.ts:277)。

### Q9. 永久允许为什么保存具体 pattern，而不是整个工具？

**关键词**：最小授权、不泛化。

```text
"允许 git push origin main" 不该变成"允许所有 Bash"。allowAlways 把本次内容取出来，超过 60 字符截断后拼 `*`，写入本地级 YAML，只匹配同前缀变体。
```

证据：[checker.ts](../../../../src/permissions/checker.ts:372) 与 [checker.ts](../../../../src/permissions/checker.ts:340)。

### Q10. Deny 为什么变成结构化 tool result 而不是异常？

**关键词**：回灌、自我修正、保序。

```text
异常会终止 Loop；结构化错误结果会作为该工具调用的结果进历史，模型能看到"被安全策略拦截"并换路径。结果按 toolUseId 保序回灌，互不串位。
```

证据：[agent.ts](../../../../src/agent/agent.ts:248) 与 [agent.ts](../../../../src/agent/agent.ts:290)。

### Q11. Agent 如何在等待批准时保持 TUI 可交互？

**关键词**：Promise 桥、resolver、声明式 UI。

```text
Agent 不能渲染 React，UI 不该执行权限算法。onPermissionRequest 返回一个 Promise，App 把 resolve 存在 ref 里、用 state 渲染 Dialog；用户按键后 resolve(action)，Agent 从 await 继续。
```

证据：[app.tsx](../../../../src/tui/app.tsx:264) 与 [permission-dialog.tsx](../../../../src/tui/permission-dialog.tsx:31)。

### Q12. 为什么 Provider 不应该知道权限模式？

**关键词**：跨协议一致、关注点分离。

```text
权限属于编排层，Anthropic/OpenAI 只负责协议差异。两者进入 Agent 后都是统一 tool_use，权限流水线天然跨协议复用；把权限塞进 Provider 会破坏这个边界。
```

证据：checker 与 agent 代码均不引用具体 Provider 类；协议层在 [llm/](../../../../src/llm/)。

## 5. 深挖追问

| 追问 | 回答方向 |
| --- | --- |
| 黑名单和模式矩阵顺序反了会怎样？ | `git branch -D` 若先被安全前缀放行就永远到不了黑名单；所以安全前缀列表刻意排除带写变体的子命令。 |
| 规则三层文件之间谁优先？ | user -> project -> local 顺序，先命中即返回；单文件内末条优先。 |
| 会话级放行为什么 UI 不暴露？ | 为未来 HITL "本次会话允许"预留 API，当前 Dialog 只有三选一。 |
| 沙箱对不存在的文件怎么处理？ | 沿最近存在的祖先做 realpath，再拼回叶子，既允许新建又防软链。 |
| manual 模式下还有没有防线？ | 黑名单和沙箱仍生效；未覆盖的危险命令会被放行，这是用户主动承担的边界。 |
| check() 之后到执行之间被攻击怎么办？ | 存在 TOCTOU 窗口（如执行前创建软链），当前未做执行时复查，是已知局限。 |
| 与 LangGraph/权限中间件如何对应？ | PermissionChecker 类似节点执行前的策略中间件；Promise 桥是编排层与 UI 的解耦点。 |

## 6. 简历表达

```text
QiCode | TypeScript, Node.js, Ink
- 设计 7 层短路权限流水线（安全命令/危险黑名单/路径沙箱/规则引擎/模式矩阵），统一 Allow/Deny/Ask 三态决策并结构化回灌给模型，实现"护栏内自主"的工具执行。
- 实现真实路径沙箱：resolve + relative + 最近存在祖先 realpath，拦截路径穿越、前缀碰撞与符号链接逃逸。
- 通过 Promise 桥接入人在回路：Ask 暂停 Agent 弹窗三选一（允许/永久允许/拒绝），Esc 等同拒绝且不破坏 Loop 与结果配对。
- 实现三级 YAML 规则引擎（用户/项目/本地、现读现匹配、损坏配置降级为空规则）与四档权限模式运行时切换。
```

不要写：

- "实现生产级安全沙箱"——Bash 不做路径沙箱，黑名单是启发式。
- "manual 模式也绝对安全"——未覆盖命令会被放行。
- "完美防止所有危险操作"——黑名单 14 条固定、不可扩展，存在 TOCTOU。

## 7. 推荐学习顺序

1. 先读 [Debug 文档](../Debug/05-auth/README.md) 的架构地图与断点路线。
2. 阅读 [checker.ts](../../../../src/permissions/checker.ts:383) 的 `check()` 主干，逐层看 reason。
3. 沿 [agent.ts](../../../../src/agent/agent.ts:228) 的 `executeBatch` 看三态分流。
4. 看 [permission-dialog.tsx](../../../../src/tui/permission-dialog.tsx:23) 与 [app.tsx](../../../../src/tui/app.tsx:264) 的 Promise 桥。
5. 跑 `tests/permissions.test.ts` 并临时改 `return "deny"` 为 `"allow"` / `"allowAlways"` 观察三分支。
6. 脱稿回答 Q1、Q4、Q5、Q6、Q10、Q11。

## 8. 独立练习

给 `PermissionChecker.check()` 增加一个"先检查用户级规则、再检查黑名单"的变体，观察哪些场景会变得不安全（如 `Bash(*) allow` 放行 `rm -rf /`），并回答：

- 为什么硬策略必须排在用户规则之前？
- 如果规则先命中，`reason` 应该标成什么来源？
- 用 `tests/permissions.test.ts` 加一个用例证明你的顺序选择是对的。
