# 07-Context Debug：跟踪一次长任务如何不撑爆上下文

> 适用代码：QiCode 第 07 章当前实现。本文不是 API 手册，而是调试路线：从一条工具输出进入会话开始，跟到它被临时替换、历史被压缩、模型报错后恢复，以及压缩边界写入 JSONL。

## 1. 本章解决了什么

一个 Agent 的上下文不只包含用户聊天，还包含：系统提示、历史回复、工具调用参数和工具输出。尤其是 `ReadFile`、`Bash`、`Grep`，一次可能返回几十 KB。若每轮都把完整历史发送给模型，最终会遇到上下文窗口上限。

第七章解决的是两个不同的问题：

```text
问题 1：某一条工具输出太大
解决：完整内容落盘；发给模型的副本只保留路径和预览。

问题 2：整个会话太长
解决：旧历史总结为摘要；最近消息保持原文。
```

最重要的设计是把两份历史分开：

```text
Conversation 完整历史                API 临时历史
--------------------                -----------------------------
保留完整工具输出              ->    允许预览、裁剪、摘要替换
任务事实来源                        本轮 Provider.stream 的输入
不因预算直接丢信息                  每轮重新构造，可安全变化
```

## 2. 架构地图

```text
src/toolresult/
  state.ts        同一 toolUseId 的替换决定固定下来
  budget.ts       落盘、预览、聚合预算、旧输出裁剪
  reconstruct.ts  临时消息数组 -> Conversation

src/compact/
  recovery.ts     记录最近读过的文件、使用过的 Skill
  compact.ts      估算、阈值、保留最近消息、请求摘要、熔断

src/session/
  session.ts      JSONL 写入 compact_boundary，未来恢复时重建消息

src/agent/
  agent.ts        每轮把上述模块串起来
  events.ts       把 compact 结果通知 TUI

src/tui/
  app.tsx         /compact、显示提示、保存 boundary
```

模块之间的依赖方向：

```text
toolresult  -> 不依赖 Agent、TUI、Provider
recovery    -> 不依赖 Agent、TUI、Registry
compact     -> 依赖 Conversation + Provider + RecoveryState
session     -> 依赖 Conversation 消息类型，不依赖 Agent
Agent       -> 调用 toolresult + compact
App         -> 消费 Agent compact 事件，并写 session
```

这样做的好处是：预算算法可以单测；压缩器不关心终端 UI；Agent 不直接写 JSONL。

## 3. 一次完整数据流

假设模型调用 `ReadFile`，文件实际有 80KB；之后又连续执行很多轮任务。

```text
1. Agent.executeTools()
   ReadFile 返回 80KB
   -> Conversation.addToolResultsMessage()
   -> 完整 80KB 留在 Conversation

2. 下一轮 Agent.run()
   -> manageContext()
      判断整个历史是否接近上下文阈值

3. Agent.streamResponse()
   -> conversation.getMessages()                 完整历史
   -> applyBudget(messages, workDir, state)      临时副本
      80KB > 50KB：writeSpill()
      写 .qicode/tool_results/<toolUseId>
      原文换成 buildSpillPreview() 的 2KB 预览
   -> buildConversation()                        临时 Conversation
   -> provider.stream({ messages: apiHistory })

4. Provider 返回 usage
   -> Agent.recordEvent()
   -> #usageAnchor = 本次真实 usage + 发送消息数量

5. 某次 manageContext() 判断超阈值
   -> doCompact()
   -> 旧消息发给 Provider 生成摘要（不传 tools）
   -> Conversation.replaceWithCompacted(summary, toKeep)
   -> compact event -> App -> saveCompactBoundary()

6. 如果 Provider 仍抛 ContextTooLongError
   -> Agent.run() -> forceCompact()
   -> 重试一次
   -> 第二次仍超长：停止当前任务
```

## 4. 文件和函数速查

| 文件 | 函数/对象 | 输入 | 输出/副作用 | 为什么放这里 |
| --- | --- | --- | --- | --- |
| `toolresult/state.ts` | `ContentReplacementState` | toolUseId、原文、替换文本 | 记住第一次替换决定 | 防止同一历史每轮变成不同预览 |
| `toolresult/budget.ts` | `applyBudget()` | 完整 `ConversationMessage[]` | 新数组，不改输入 | 生成 API 临时副本 |
| `toolresult/budget.ts` | `writeSpill()` | workDir、toolUseId、内容 | 写 `.qicode/tool_results/` | 保存被模型省略的原文 |
| `toolresult/reconstruct.ts` | `buildConversation()` | 临时消息数组 | 临时 Conversation | Provider 当前接口接收消息数组，但此函数让构造过程显式 |
| `compact/compact.ts` | `manageContext()` | Conversation、窗口、usage anchor | 是否压缩及提示 | 自动压缩入口 |
| `compact/compact.ts` | `doCompact()` | Conversation、Provider、RecoveryState | 摘要、保留消息、boundary | 真正调用摘要模型 |
| `compact/compact.ts` | `computeKeepStartIndex()` | 消息数组 | 保留窗口起点 | 保护最近上下文及工具配对 |
| `compact/recovery.ts` | `RecoveryState` | 文件/Skill 快照 | 恢复附件文本 | 摘要不丢当前工作现场 |
| `session/session.ts` | `saveCompactBoundary()` | 摘要 + 完整消息 block | 追加一行 JSONL | 给第八章恢复会话提供边界 |
| `agent/agent.ts` | `Agent.run()` | Agent 配置 | AgentEvent 流 | 统一编排点 |
| `agent/agent.ts` | `Agent.streamResponse()` | 完整会话、工具 schema | Provider 请求结果 | API 副本实际生效的位置 |
| `tui/app.tsx` | `App.submit()` | `/compact` | 调 forceCompact、保存 boundary | 手动压缩入口 |

## 5. 推荐断点路线

### D1：工具结果先保存到哪里

- 断点：`Agent.executeTools()`，观察 `results`、`resultBlocks`、`this.config.conversation.getMessages()`。
- 正常现象：`resultBlocks.content` 是工具返回的完整字符串，不是 10KB 截断文本。
- 为什么：第七章把截断从执行时移到请求前。执行结果是事实；预算只是模型请求优化。
- 下一步：继续进 `Agent.streamResponse()`，对比完整历史与 `apiConversation`。

### D2：API 副本在哪里创建

- 断点：`Agent.streamResponse()`。
- 观察变量：`messages`、`apiConversation.getMessages()`、`sentMessageCount`。
- 正常现象：两者不是同一数组。大结果只在 `apiConversation` 中变成 `<persisted-output>`。
- 异常含义：如果完整 `messages` 也被替换，说明预算逻辑误改了 Conversation，后续无法恢复完整结果。

### D3：大输出如何落盘

- 断点：`applyBudget()`，再进 `writeSpill()` 与 `buildSpillPreview()`。
- 观察变量：`block.content.length`、`SINGLE_RESULT_LIMIT`、`toolUseId`、`path`、`state.getReplacement(toolUseId)`。
- 正常值：长度大于 50,000 时才写 `.qicode/tool_results/<toolUseId>`；预览最多带前 2,000 字符。
- 安全点：`writeSpill()` 只接受 `[A-Za-z0-9_-]` 的 id，且检查最终路径仍在目标目录中。
- 下一步：再次调用 `applyBudget()`，确认同一 id 直接命中 `getReplacement()`，预览逐字相同。

### D4：为什么同一个输出不会反复变

- 断点：`ContentReplacementState.record()`、`ContentReplacementState.getReplacement()`。
- 观察：第一次出现的 id 写入 map；第二次出现同 id 时不再重算文件名或预览。
- 要证明：调用两次 `applyBudget()`，结果完全相等。
- 业务意义：同一工具结果在历史中多次出现时，模型请求前缀稳定，Prompt Cache 更容易命中。

### D5：何时自动压缩

- 断点：`manageContext()`，再进 `currentContextTokens()` 与 `computeCompactThreshold()`。
- 观察变量：`tokens`、`autoThreshold`、`hardBlock`、`tracking.consecutiveFailures`。
- 正常逻辑：

```text
tokens < autoThreshold  -> 不压缩
tokens >= autoThreshold -> 尝试 doCompact
连续失败 >= 3 且未达 hardBlock -> 熔断，不再自动压缩
tokens >= hardBlock -> 即使熔断也允许一次尝试
```

- 不要误解：`manual=true` 的阈值更接近窗口上限，名称表示手动压缩可以更激进，不是自动压缩更危险。

### D6：压缩时哪些消息留下

- 断点：`computeKeepStartIndex()` 与 `backUpPastToolUse()`。
- 观察变量：`tokens`、`count`、`start`、`resultIds`。
- 正常逻辑：至少留 5 条消息，目标保留最近约 10,000 token，最大不超过 40,000 token。
- 关键案例：保留窗口第一条若是 `tool_result`，函数会倒找对应的 assistant `tool_use` 并将起点前移。
- 原因：模型需要知道“这个工具结果是如何产生的”，否则恢复后的历史不完整。

### D7：摘要请求与正常请求有什么不同

- 断点：`doCompact()`，再进 `requestSummary()`。
- 观察：`toSummarize`、`toKeep`、`serializeMessages()` 结果、Provider 请求的 `tools` 字段。
- 正常现象：摘要请求只有一个 user 消息，**不带 `tools`**；模型只能总结，不能在压缩时再调用工具。
- 摘要返回空字符串：`requestSummary()` 抛错；自动路径在 `manageContext()` 记录失败并保留原会话。

### D8：usage anchor 如何降低误差

- 断点：`Agent.recordEvent()` 的 `usage` 分支。
- 观察：`event.inputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`outputTokens`、`#usageAnchor`。
- 正常计算：

```text
baselineTokens = input + cacheRead + cacheCreation + output
anchorCount    = 这次发送给 Provider 前完整历史的消息数
下一轮预算    = baselineTokens + anchorCount 之后的新消息近似值
```

- 原因：字符除以 3.5 是近似；Provider usage 是已发送部分的真实测量。两者组合比每轮从头猜整段历史稳定。

### D9：Provider 已拒绝时如何恢复

- 断点：`Agent.run()` 中 `streamResult === "context_too_long"` 分支。
- 观察：`contextRecoveryAttempted`、`result.compacted`、`#usageAnchor`。
- 正常逻辑：第一次超长 -> `forceCompact()` -> 清空 anchor -> `continue` 重发；第二次超长 -> `loop_complete(context_too_long)`。
- 为什么不是无限重试：每次摘要都是一次模型请求，持续重试只会浪费 token 并卡住任务。

### D10：压缩边界怎么写到 JSONL

- 断点：`App.submit()` 的 `/compact` 分支，或 App 消费 `event.type === "compact"` 的分支。
- 观察：`result.boundary` / `event.boundary`、`sessionIdRef.current`、`.qicode/sessions/<id>.jsonl`。
- 正常结构：一行 `type: "compact_boundary"`，content 中是 `{ summary, keep }`。`keep` 保存完整 Conversation block，包含 text、thinking、tool_use、tool_result。
- 下一步：`rebuildFromSession()` 倒序找最后一个边界，重建摘要 + keep + 边界之后的新消息。

## 6. 故障注入实验

### 实验 1：验证完整历史不会被落盘逻辑破坏

1. 在测试工具中返回 `"x".repeat(50_001)`。
2. 执行一次工具调用，查看 `Conversation.getMessages()`。
3. 再触发下一轮 Provider 请求。

预期：Conversation 仍是 50,001 字符；Provider 请求里是 `<persisted-output>`；磁盘出现工具结果文件。

### 实验 2：非法 toolUseId

1. 直接调用 `writeSpill(workDir, "../escape", "x")`。
2. 观察异常。

预期：抛 `Invalid toolUseId for persisted output`，工作区外没有新文件。

### 实验 3：摘要模型返回空结果

1. Fake Provider 的 `stream()` 只 yield `{ type: "done" }`。
2. 调 `forceCompact()` 或触发 `manageContext()`。

预期：`forceCompact()` 抛 `Provider returned an empty compaction summary`；自动路径返回 `Auto-compact failed: ...`，原 Conversation 不变。

### 实验 4：连续摘要失败与熔断

1. 连续三次让摘要 Provider 抛异常。
2. 第四次仍让会话处于 autoThreshold 与 hardBlock 之间。

预期：`AutoCompactTrackingState.consecutiveFailures === 3`，第四次返回 circuit breaker，不发第四个摘要请求。

### 实验 5：上下文超长恢复

1. 正常 Provider 第一次 `stream()` 抛 `new ContextTooLongError()`。
2. 第二次返回文本。

预期：事件顺序含 `compact`，后续返回正常文本。将第二次也改为超长，预期 Agent 停止且不出现第三次 Provider 请求。

### 实验 6：工具配对边界

1. 造一段 assistant `tool_use(ReadFile, id=a)` + user `tool_result(a)`，让 keep 起点原本落在工具结果上。
2. 调 `computeKeepStartIndex()`。

预期：返回的索引应回退到 assistant tool_use，不允许只保存结果。

### 实验 7：session 恢复完整 block

1. 保存 boundary，其中 keep 包含 `tool_use` block。
2. 调 `rebuildFromSession()`。

预期：恢复结果仍包含同一个 `tool_use` 的 id/name/input，而不是被转为一段普通文本。

## 7. 当前测试与验证

```text
pnpm.cmd test       33 个测试文件、175 个测试通过
pnpm.cmd typecheck  通过
pnpm.cmd build      通过
git diff --check    通过
```

本章新增或更新的覆盖重点：`tests/toolresult.test.ts`、`tests/compact.test.ts`、`tests/session.test.ts`、`tests/conversation/conversation.test.ts`、`tests/agent/agent.test.ts`。

## 8. 建议学习顺序

1. 先读 `Conversation` 的 `getMessages()` 与 `replaceWithCompacted()`，明确完整历史在哪里。
2. 读 `applyBudget()`，明确 API 副本如何产生。
3. 读 `Agent.streamResponse()`，确认预算代码不是死代码。
4. 读 `manageContext()` 和 `doCompact()`，理解预防性压缩。
5. 回到 `Agent.run()` 看超长错误的兜底恢复。
6. 最后读 `App.submit()` 的 `/compact` 与 `rebuildFromSession()`，理解边界为什么要持久化。
