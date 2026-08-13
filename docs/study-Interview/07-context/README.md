# 07-Context 面试学习文档：上下文管理

## 1. 这一章在简历上可以怎么说

```text
QiCode | TypeScript, Node.js, Ink, Vitest
- 设计 Agent 上下文管理链路：完整 Conversation 与 Provider API 副本分离，模型请求前统一执行大工具结果落盘、预览替换和旧结果裁剪，避免长任务撑爆上下文。
- 实现自动压缩与有界恢复：字符近似估算结合 Provider usage anchor，在接近窗口时总结旧历史并保留最近原文；ContextTooLongError 时只强制压缩并重试一次，避免无限 token 消耗。
- 实现 JSONL compact boundary：保存摘要和完整消息 block（含 tool_use/tool_result），为后续会话恢复提供稳定边界，避免工具调用配对在恢复时丢失。
- 提供 /compact 与 /c 手动压缩入口，自动与手动压缩共用事件和持久化格式；完整测试、类型检查与构建均通过。
```

不要写：

- “实现了精确 token 计费”——这里是近似预算加 usage 锚点，不是 tokenizer。
- “已经实现完整历史恢复”——保存了 boundary，`/resume` 是第八章。
- “保证永不超上下文”——仍可能因 Provider 真实限制触发一次兜底恢复。

## 2. 30 秒自我介绍版本

> 我在 Agent 的模型调用前增加了上下文调度层。完整会话保存真实工具输出，发送给模型时才构造临时副本：超过阈值的工具输出落盘并替换成路径和预览；整段历史接近窗口时，用模型总结旧消息并保留最近原文。预算采用字符近似和 Provider usage anchor 结合，Provider 仍报超长时只允许一次强制压缩加重试，避免无限 token 消耗。

## 3. 高频问题

### Q1：为什么完整历史和 API 历史必须分开？

**一句话**：完整历史保存事实，API 历史服务于本轮模型输入预算。

**项目回答**：`Agent.streamResponse()` 先从 `Conversation.getMessages()` 取得完整历史，再调用 `applyBudget()` 和 `buildConversation()` 生成临时 `apiConversation`。完整历史中的 80KB 工具结果不被删；临时副本中才替换成 `<persisted-output>`。如果直接改完整历史，模型以后需要日志结尾或完整代码时，信息已经永久丢失。

**追问：为什么不每次都从落盘文件恢复完整内容？**

因为模型不总需要完整内容。路径和预览让模型先判断是否相关，再主动用工具读取，避免每轮都重新把 80KB 塞回上下文。

**代码定位**：`Agent.streamResponse()`、`applyBudget()`、`buildConversation()`。

### Q2：为什么大工具输出要落盘而不是截断？

**一句话**：截断不可逆，落盘是可定位、可恢复的压缩。

**项目回答**：`writeSpill()` 将完整内容写入 `.qicode/tool_results/<toolUseId>`；`buildSpillPreview()` 给模型路径、大小和前 2KB 预览。模型知道完整内容还在，不会把预览误认为完整结果。旧版本在工具执行后立刻截断 10KB，会丢失结尾错误；第七章把预算移动到请求前。

**追问：怎么避免路径穿越？**

`writeSpill()` 限制 `toolUseId` 只含字母、数字、下划线和连字符，并用 `relative()` 检查最终路径没有逃出 spill 目录。已有同名文件时，内容相同才复用，不同则报冲突，不静默覆盖。

**代码定位**：`writeSpill()`、`buildSpillPreview()`、`Agent.executeTools()`。

### Q3：ContentReplacementState 为什么必要？

**一句话**：同一工具结果的替换内容必须稳定。

**项目回答**：历史会跨多轮反复发送。如果每次预算都重新命名文件或重新裁剪，同一个 `toolUseId` 会在每轮变成不同文本，模型输入前缀抖动，Prompt Cache 命中下降。`ContentReplacementState.record()` 第一次决定替换文本，`getReplacement()` 在以后直接复用。

**追问：为什么不跨进程保存这个 state？**

本章只解决单个 Agent 生命周期内的稳定性。跨进程恢复以 JSONL boundary 为基础，完整 `/resume` 的语义留给第八章。

**代码定位**：`ContentReplacementState`、`applyBudget()`。

### Q4：自动压缩何时触发？

**一句话**：估算 token 超过“窗口减输出预留减安全余量”时触发。

**项目回答**：`computeCompactThreshold()` 先从 `contextWindow` 扣掉本轮最大输出和安全余量。`manageContext()` 比较 `currentContextTokens()` 与阈值：未到阈值不调摘要模型；超过阈值才调用 `doCompact()`。这样压缩是预防性动作，而不是等请求失败后才处理。

**追问：为什么手动压缩的余量更小？**

用户输入 `/compact` 是明确意图，可以更接近窗口边界。自动模式保留更大的余量，减少普通请求撞 Provider 限制的概率。

**代码定位**：`computeCompactThreshold()`、`manageContext()`、`App.submit()`。

### Q5：为什么不使用精确 tokenizer？

**一句话**：统一 Provider 架构下，精确 tokenizer 并不统一；预算需要的是提前避险而非计费精度。

**项目回答**：Anthropic 与 OpenAI tokenizer 不同，当前 Provider 抽象没有暴露统一 tokenizer。`estimateMessages()` 用字符数除以 3.5 得到快速近似；Provider 返回 usage 后，`Agent.recordEvent()` 保存 `UsageAnchor`，下一轮只估算锚点之后新增消息。近似用于预测，真实 usage 用于校正。

**追问：anchor 为什么要加 output token？**

因为响应文本、工具调用和后续历史都会占上下文，锚点表示刚完成一轮后模型实际处理的整体规模，而不是只记录 prompt。

**代码定位**：`estimateMessages()`、`currentContextTokens()`、`Agent.recordEvent()`。

### Q6：压缩时为什么保留最近原文？

**一句话**：最近几步包含当前任务最容易丢失的精确参数和工具结果。

**项目回答**：`doCompact()` 将 `messages.slice(0, keepStart)` 交给摘要模型，将 `messages.slice(keepStart)` 原样保留。`computeKeepStartIndex()` 至少保留 5 条，目标保留最近约 10K token。只留摘要会让模型失去刚刚读取的文件片段、命令参数和用户最新限制。

**追问：为什么还要保护 tool_use/tool_result 配对？**

如果保留窗口从 user 的 `tool_result` 开始，模型会看到“输出”，却不知道调用了什么工具、用了什么参数。`backUpPastToolUse()` 会找到对应 assistant `tool_use` 并前移起点。

**代码定位**：`computeKeepStartIndex()`、`backUpPastToolUse()`、`doCompact()`。

### Q7：摘要请求为什么不带工具 schema？

**一句话**：压缩阶段只需要总结，不应该执行新动作。

**项目回答**：`requestSummary()` 调用 `provider.stream()` 时只传 systemPrompt 和一个 user message，不传 `tools`。这样模型不会在整理历史时调用 `ReadFile`、Bash 或 MCP 工具。压缩函数的副作用应该只有替换会话，不应该扩展任务范围。

**追问：摘要模型返回空文本怎么办？**

`requestSummary()` 抛错；自动路径由 `manageContext()` 捕获，增加 `consecutiveFailures`，原 Conversation 不修改。手动路径则直接把错误展示给用户。

**代码定位**：`requestSummary()`、`manageContext()`、`forceCompact()`。

### Q8：如何避免自动压缩变成无限调用？

**一句话**：自动路径有熔断，Provider 超长恢复有单次上限。

**项目回答**：`AutoCompactTrackingState` 记录连续摘要失败次数。`manageContext()` 在未达到 hardBlock 时，三次失败后返回 circuit breaker，不再请求摘要模型。另一方面，`Agent.run()` 捕获 `ContextTooLongError` 后设置 `contextRecoveryAttempted`，只调用一次 `forceCompact()` 和重试；第二次仍超长则停止当前任务。

**追问：为什么达到 hardBlock 后可绕过熔断？**

因为已经接近必然失败的窗口，继续不压缩更可能撞 Provider；此时允许再尝试一次的成本小于直接让任务无法继续。

**代码定位**：`AutoCompactTrackingState`、`manageContext()`、`Agent.run()`。

### Q9：RecoveryState 是什么，为什么摘要还需要它？

**一句话**：摘要记录“发生过什么”，RecoveryState 补“刚在看什么”。

**项目回答**：`RecoveryState.recordFileRead()` 记录最近成功读取的文件原文，`recordSkillInvocation()` 记录活跃 Skill；`buildRecoveryAttachment()` 给每部分独立预算后拼到摘要附近。压缩后模型知道最近工作涉及哪些文件和工具；但提示明确要求需要当前字节时重新读取，避免把旧快照当事实。

**追问：为什么不把所有读过的文件都塞进附件？**

那会让恢复附件本身再次撑爆上下文。实现默认只取最近 5 个文件、每文件 5K token，并限制 Skill 总预算。

**代码定位**：`RecoveryState.recordFileRead()`、`buildRecoveryAttachment()`、`Agent.recordReadFiles()`。

### Q10：为什么 session 用 JSONL，而不是一个大 JSON 数组？

**一句话**：会话是持续追加的事件流，JSONL 更适合 append。

**项目回答**：`saveMessage()` 每次只向 `.qicode/sessions/<sessionId>.jsonl` 追加一行，不需要读全文件再改写数组。`saveCompactBoundary()` 写一条 `type="compact_boundary"` 的 system 记录，内容保存摘要和完整 keep blocks。恢复时 `rebuildFromSession()` 倒序找到最后一个 boundary，再拼摘要、保留消息和边界后的新消息。

**追问：为什么只用最后一个 boundary？**

后一次压缩已经覆盖早一次压缩对应的历史，使用最后一个边界能避免把过期摘要重复拼回去。

**代码定位**：`saveMessage()`、`saveCompactBoundary()`、`rebuildFromSession()`。

### Q11：为什么 boundary 要保存完整 block，而不是只存可见文本？

**一句话**：工具调用协议不是纯文本，丢 block 会破坏 tool_use/tool_result 配对。

**项目回答**：boundary 中的 `keep` 保存 `ConversationBlock[]`，包括 `text`、`thinking`、`tool_use`、`tool_result`。如果只用 `Conversation.visibleText()`，工具调用参数和工具结果会丢失，未来恢复时模型上下文不完整。`isConversationBlock()` 在读取 boundary 时验证每种 block 的结构。

**代码定位**：`doCompact()`、`CompactBoundaryPayload`、`isConversationBlock()`。

### Q12：手动 `/compact` 与自动压缩有什么不同？

**一句话**：执行器相同，触发条件不同，持久化结果相同。

**项目回答**：`App.submit()` 收到 `/compact` 或 `/c` 直接调 `forceCompact()`，不看阈值也不受熔断限制；自动压缩由 `Agent.run()` 调 `manageContext()`。两条路径都生成 `CompactResult.boundary`，并由 App 调 `saveCompactBoundary()` 写入同一种 JSONL 格式。

**追问：为什么忙碌时不允许 `/compact`？**

流式请求正在读取和写入同一个 Conversation；并发压缩可能让 Provider 请求与会话状态不一致。因此 App 在 busy 时直接忽略手动命令。

**代码定位**：`App.submit()`、`forceCompact()`、`Agent.run()`。

## 4. 深挖追问速查

| 追问 | 回答方向 |
| --- | --- |
| 为什么预览只保留前 2KB，错误常在结尾怎么办？ | 预览用于判断是否相关，不保证覆盖错误；完整文件落盘后模型可主动再读。未来可扩展首尾双预览，但必须保持替换文本稳定。 |
| `writeSpill()` 为什么冲突时抛错？ | 同一个 toolUseId 对应不同内容说明调用身份或状态出现错误；静默覆盖会破坏历史可追溯性。 |
| 为什么 `applyBudget()` 是同步文件写入？ | 这里只写几十 KB 的本地文件，错误需要立即冒泡；改 async 会把 await 传播进请求构造路径。性能压力变大后再做异步队列。 |
| usage anchor 为什么保存消息数量？ | Provider usage 是某次完整历史的真实基线；消息数量定位基线之后新增的部分，避免全历史重复近似估算。 |
| 摘要会不会损失信息？ | 会，这是压缩必然代价。因此保留最近原文、恢复附件、落盘路径，并保留用户手动 /compact 的控制。 |
| 为什么 RecoveryState 不持久化？ | 它是本进程短期工作现场；跨进程恢复需要明确的数据格式和隐私策略，第八章再定义。 |
| 为什么工具输出落盘用 `.qicode`，配置用 `.QiCode`？ | 当前实现区分运行时数据与用户配置；二者都被工具扫描排除，运行时目录已被 gitignore。可作为后续统一命名的改进点。 |
| `ContextTooLongError` 前已经流出部分文本怎么办？ | 当前 Agent 不会把未完成 response 作为完整 assistant 消息提交，恢复后重发当前请求；这是避免历史出现半截工具调用的取舍。 |

## 5. 简历和项目追问

面试官问“你做的不是普通聊天应用吧，难点在哪？”可以回答：

> 难点不在于调用模型，而在于长任务的上下文治理。我把真实会话和模型请求历史分开，工具结果不会因为省 token 被永久截断。压缩时还要处理工具调用配对、Provider 真实 usage、失败熔断和超长后的单次恢复。最后我把压缩边界写成 JSONL，保存完整消息 block，为后续恢复会话留出正确的协议边界。

面试官继续问“如果要生产化还缺什么？”可以诚实回答：

1. 加 `/resume <sessionId>`、会话列表和 session 生命周期管理。
2. 为长任务做摘要质量评估，例如比较压缩前后任务约束是否丢失。
3. 让 Provider 暴露模型实际 context window，而不是 App 里按 protocol 写固定默认值。
4. 对 `.qicode/tool_results` 加配额、清理策略和用户可见的查看命令。
5. 对超长输出用首尾预览、结构化日志摘要或按工具类型定制策略。

## 6. 推荐学习顺序与练习

1. 先脱稿画出“完整历史 -> API 副本 -> Provider”的两份历史图。
2. 读 `applyBudget()`，自己解释为什么它返回新数组。
3. 读 `Agent.streamResponse()`，找出 API 副本真正传给 Provider 的那一行。
4. 读 `computeKeepStartIndex()`，自己构造工具调用配对场景。
5. 读 `Agent.run()` 的 `ContextTooLongError` 分支，解释为什么只有一次恢复。
6. 读 `saveCompactBoundary()` 与 `rebuildFromSession()`，理解 JSONL 的最后边界语义。

独立练习：为 `buildSpillPreview()` 增加“前 1KB + 后 1KB”预览。

- 先写测试：同样输入必须保持逐字稳定；短输出不能重复内容；总预览不能超过固定上限。
- 再改实现。
- 最后检查它是否会改变 `ContentReplacementState` 的稳定性，以及如何让已有落盘文件的预览兼容。
