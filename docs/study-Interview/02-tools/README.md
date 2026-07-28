# 02-Tools Interview 学习文档：用真实代码讲 QiCode 工具闭环

> 只基于当前第 02 章代码和已通过的 112 项自动化测试。配套调试路径见 `docs/study/Debug/02-tools/README.md`。

## 1. 30 秒项目介绍

```text
QiCode 是我用 TypeScript 做的终端 AI Coding Agent。目前在流式对话内核之上，完成了一批本地工具闭环。
它通过统一 Provider 接口兼容 Anthropic 和 OpenAI 协议；Provider 把不同的 SSE 工具调用分片翻译成统一事件。
Agent 用 AsyncGenerator 编排“模型请求、工具执行、结果回灌、最终回答”，TUI 只消费事件并渲染状态。
目前支持读写文件、精确编辑、命令执行、Glob 和 Grep；每次请求最多执行一批工具，后续多轮 Loop 会在下一章实现。
```

## 2. 面试先画的架构图

```text
Ink App
  -> Agent.run()
      -> Provider.stream() -> SSE -> tool_call_complete
      -> StreamingExecutor -> ToolRegistry -> Tool
      -> Conversation 写入 tool_use / tool_result
      -> Provider.stream() -> 最终文本
  -> ChatView / ToolDisplay
```

讲图时强调两件事：

- `Provider` 解决“不同厂商协议”的问题；`Agent` 解决“一个用户任务如何推进”的问题。
- 工具不是模型直接执行的。模型只生成结构化调用意图，QiCode 本地代码才真正执行文件或命令操作。

## 3. 高频问题

### Q1. 为什么要有 Agent 层，不能直接在 App 里调用工具吗？

**关键词**：编排、UI 解耦、AsyncGenerator、可测试。

参考回答：

```text
App 的职责是接收输入和渲染状态。如果把“请求模型、解析工具调用、执行工具、回灌结果、再次请求模型”都写在 React 组件里，组件会同时管理网络、业务状态和界面状态，很难测试。
所以我把这条链放进 Agent.run()。它返回 AsyncGenerator<AgentEvent>：Agent 按事件逐步产出文本、工具开始、工具结果和完成信号，App 用 for await 消费即可。
这样 tests/agent/agent.test.ts 可以用 FakeProvider 验证闭环，不需要启动 Ink 或真实 API。
```

代码证据：[agent.ts](../../../src/agent/agent.ts:28)、[app.tsx](../../../src/tui/app.tsx:135)、[agent.test.ts](../../../tests/agent/agent.test.ts:34)。

### Q2. Anthropic 和 OpenAI 的工具调用格式不同，怎样统一？

**关键词**：适配器、统一事件、协议隔离。

参考回答：

```text
我定义了 Provider 和 StreamEvent 作为协议无关边界。Anthropic 在 content block 中用 input_json_delta 给参数分片；OpenAI 在 delta.tool_calls[index].function.arguments 中给分片。
两个 Provider 各自在内部累计 JSON，最后都输出 tool_call_complete { toolId, toolName, arguments }。Agent 完全不需要判断当前是 Anthropic 还是 OpenAI。
```

代码证据：[types.ts](../../../src/providers/types.ts:8)、[anthropic.ts](../../../src/providers/anthropic.ts:101)、[openai.ts](../../../src/providers/openai.ts:93)。

### Q3. 为什么工具参数不能一收到分片就 JSON.parse？

**关键词**：SSE、拆包、流式、缓冲。

参考回答：

```text
因为网络和 SSE 都不保证一段参数一次完整到达。比如 {"file_path":"README.md"} 可能先到 {"file_，后到剩余内容。每个分片直接 JSON.parse 会失败。
因此 Provider 先按 Anthropic 的 block index 或 OpenAI 的 tool call index 放进 Map，持续拼接 argumentsJson，到工具块结束或 finish_reason 到来时才解析完整 JSON。
```

### Q4. 一次工具调用的“结果回灌”到底是什么？

**关键词**：会话历史、tool_use、tool_result、第二次请求。

参考回答：

```text
第一次模型请求不是最终回答，而是 assistant 消息中的 tool_use。QiCode 执行工具后，把结果保存成 user 消息中的 tool_result，然后把完整 Conversation 发给模型第二次请求。
模型不是天然能访问本地文件；它只是从 tool_result 的文本里得到文件内容，再生成总结。
```

代码证据：[agent.ts](../../../src/agent/agent.ts:50)、[conversation.ts](../../../src/conversation/conversation.ts:32)、[agent.ts](../../../src/agent/agent.ts:76)。

### Q5. 为什么不允许工具无限循环调用？

**关键词**：范围控制、成本、可靠性、下一阶段。

参考回答：

```text
当前版本只允许一批工具，之后只允许模型输出最终文本。如果第二次仍请求工具，Agent 产生错误事件但不执行。
这样可以先验证协议、历史和 UI 闭环，同时避免无限循环、不可控成本和难以恢复的副作用。第 03 章再加入明确的最大轮数、取消策略和完整 Agent Loop。
```

代码证据：[agent.ts](../../../src/agent/agent.ts:76)、[agent.ts](../../../src/agent/agent.ts:128)、[agent.test.ts](../../../tests/agent/agent.test.ts:74)。

### Q6. 多个工具为什么并发执行？会不会有问题？

**关键词**：Promise.all、延迟、依赖关系、当前限制。

参考回答：

```text
同一次模型响应中的工具调用由 StreamingExecutor.collectResults() 用 Promise.all 执行，减少互不依赖操作的总等待时间，例如同时 Glob 和 Grep。
但这只是第一版策略，默认假设该批调用互不依赖。写同一文件、先写后读这类有顺序依赖的行为不应该由模型在同一批并发工具中表达；后续 Loop 或执行策略需要区分读写和依赖关系。
```

代码证据：[streaming-executor.ts](../../../src/agent/streaming-executor.ts:37)。

### Q7. 工具错误为什么不直接 throw？

**关键词**：错误即数据、恢复、模型纠错。

参考回答：

```text
文件不存在、编辑匹配不到、命令非零退出都是用户任务中的正常失败，不应该让整个 TUI 退出。ToolResult 统一为 output 加 isError；StreamingExecutor 还捕获未知工具和未预期异常。
错误会作为 tool_result 回给模型，模型可以根据错误选择解释或调整方案，用户也能继续下一轮对话。
```

代码证据：[streaming-executor.ts](../../../src/agent/streaming-executor.ts:42)、[read-file.ts](../../../src/tools/read-file.ts:52)、[edit-file.ts](../../../src/tools/edit-file.ts:47)。

### Q8. 如何控制大文件、大搜索结果和 token 成本？

**关键词**：分层上限、上下文、可用性。

参考回答：

```text
我做了三层控制。工具层限制 ReadFile 默认 2000 行、Glob 1000 条、Grep 500 条、Bash 10MB。Agent 层还有 MAX_TOOL_OUTPUT_CHARS=10000 的统一兜底，防止少量超长行绕过行数限制。UI 再只显示最多 500 字符，避免终端刷屏。
三层目的不同：工具层控制源头，Agent 层保护模型上下文，UI 层保护阅读体验。
```

代码证据：[read-file.ts](../../../src/tools/read-file.ts:31)、[grep.ts](../../../src/tools/grep.ts:6)、[bash.ts](../../../src/tools/bash.ts:6)、[agent.ts](../../../src/agent/agent.ts:11)、[tool-display.tsx](../../../src/tui/tool-display.tsx:30)。

### Q9. Bash 的超时为什么不只调用 kill？

**关键词**：跨平台、进程树、及时返回。

参考回答：

```text
超时时先尝试终止进程树；但特别在 Windows 上，进程完全回收可能有延迟，或者终止失败。如果 Promise 一直等待 close 事件，聊天界面会看起来卡住。
所以超时回调在发出终止请求后立即以结构化超时结果结束当前工具调用。后续 close 事件会被 settled 标记忽略。这优先保证 Agent 可恢复。
```

代码证据：[bash.ts](../../../src/tools/bash.ts:87)、[bash.ts](../../../src/tools/bash.ts:118)。

### Q10. 这套工具系统目前有什么安全问题？

**关键词**：LLM 输出不可信、权限确认、路径沙箱、命令拦截。

参考回答：

```text
目前它是学习阶段的本地工具闭环，尚未提供权限确认、工作区路径沙箱或危险命令拦截。因此模型输出虽然经过类型和工具名边界处理，但仍可能请求写任意可访问路径或执行危险 Shell 命令。
README 已明确提示只在测试目录使用。下一阶段应该加入工作区边界校验、写入和 Bash 的用户确认、危险命令策略以及审计记录；不能只依赖系统提示词约束模型。
```

代码证据：[README.md](../../../README.md:8)、[write-file.ts](../../../src/tools/write-file.ts:35)、[bash.ts](../../../src/tools/bash.ts:71)。

## 4. 追问应对

| 面试官追问 | 简短回答方向 |
| --- | --- |
| 为什么 ToolRegistry 不直接返回 OpenAI schema？ | Registry 管理通用工具定义；Provider 边界再翻译成供应商请求格式，避免工具层依赖协议。当前 Registry 仍保留 schema 导出，Agent 使用统一 `ToolDefinition` 重新映射。 |
| Tool use/result 为什么要存为 block，不是一个字符串？ | 一个 assistant 回合可能同时有 thinking、文本和多个工具调用；block 保留顺序和语义，Provider 才能正确回放。 |
| 为什么用 AsyncGenerator 而不是 EventEmitter？ | `for await` 有自然的顺序与背压，事件类型可判别联合，测试也可直接 collect；不需要手动订阅和释放监听器。 |
| 怎样证明不是只会调用工具？ | `tests/agent/agent.test.ts` 用两段 FakeProvider 流验证第二次请求收到 tool_result 后生成最终文本。 |
| 为什么不使用 Zod？ | 当前六个固定工具通过 `strArg/intArg/boolArg` 做轻量运行时取参；缺点是 JSON Schema 与运行时校验有重复风险。工具数量增长或参数复杂后，应引入单一 schema 源，例如 Zod 生成 JSON Schema。 |

## 5. 简历表达

不要写“实现了 Claude Code”。建议写事实：

```text
QiCode | TypeScript, Node.js, Ink, SSE, Anthropic/OpenAI API
- 设计协议无关 Provider 接口，统一 Anthropic 与 OpenAI Chat Completions 的流式文本和 Tool Calling 事件。
- 实现基于 AsyncGenerator 的单批工具 Agent 闭环：工具调用解析、并发执行、结果回灌与最终流式回答。
- 实现 ReadFile、WriteFile、EditFile、Bash、Glob、Grep，并加入超时、结构化错误和多层输出截断保护。
- 使用 Vitest 覆盖 Agent 闭环、双协议参数分片拼接和工具输出截断等关键路径。
```

## 6. 学习顺序

1. 先用 Debug 文档画图并走 D1 到 D7。
2. 再读 `tests/agent/agent.test.ts`，因为它是最短的完整行为说明。
3. 接着读 `agent.ts`，每读一个 `yield` 都回到 App 的事件消费分支。
4. 最后对比 Anthropic/OpenAI Provider 的参数拼接差异。
5. 练习上面 10 个问题：先按关键词说，再指向代码和调试证据。
