# 03-Loop Interview 学习文档：用多轮 Agent Loop 讲 QiCode

> 基于第 03 章最终代码和已通过的 120 项自动化测试。真实 API、取消与跨协议手工体验尚未完成，不应在面试中说成已验证。

## 1. 30 秒项目介绍

```text
QiCode 是我用 TypeScript 实现的终端 Coding Agent。它用统一 Provider 适配 Anthropic 和 OpenAI 的 SSE 流，在本机提供文件、搜索和 Shell 工具。

第 03 章我把原来的单轮工具闭环改成有限 ReAct Loop：Agent 用 AsyncGenerator 按轮调用模型；模型请求工具时，QiCode 执行工具、把 tool_use 和 tool_result 写回 Conversation，再进入下一轮；模型不再请求工具时结束。

我还加入了 20 轮上限、未知工具停止、流错误收尾、只读工具并发、写入/命令串行，以及 Plan Mode 的双重只读限制。Ink TUI 只消费 AgentEvent，展示流式文本、轮次与累计 token。
```

## 2. 面试先画的架构图

```text
Ink App
  -> Agent.run()  [循环和停止条件]
      -> Provider.stream()  [模型 SSE]
      -> StreamingExecutor  [本地工具执行]
          -> ToolRegistry -> Tool
      -> Conversation       [tool_use / tool_result]
  -> Activity / StatusBar / ChatView
```

讲图时强调：Provider 负责“和哪家模型怎么通信”；Agent 负责“一个用户任务如何连续推进”；TUI 负责“用户看见什么”。

## 3. 高频问题

### Q1. 第 02 章和第 03 章最本质的区别是什么？

**关键词**：固定两次请求、多轮循环、状态机、停止条件。

```text
第 02 章只允许一批工具，工具结果回来后再请求一次模型生成最终文本；如果模型又请求工具会停止。
第 03 章把这条固定链改为有限循环。每轮根据 response.toolUses 是否为空决定继续工具节点还是结束，因此可以完成“先读文件，再根据内容写文件”的任务。
```

证据：[agent.ts](../../../../src/agent/agent.ts:35)、[agent.test.ts](../../../../tests/agent/agent.test.ts:26)。

### Q2. 为什么用 AsyncGenerator，而不是让 Agent 直接返回最终结果？

**关键词**：流式事件、解耦、可观察性、TUI。

```text
Loop 很长，用户需要立即看到文本、工具开始、工具结果和第几轮，而不是等全部结束。AsyncGenerator 允许 Agent 一边执行一边 yield AgentEvent；App 用 for await 消费事件更新 UI。
Agent 不依赖 Ink，所以同一套流程能用 FakeProvider 做单元测试，未来也可以接 Web UI。
```

证据：[events.ts](../../../../src/agent/events.ts:1)、[agent.ts](../../../../src/agent/agent.ts:35)、[app.tsx](../../../../src/tui/app.tsx:147)。

### Q3. 你的循环如何停止，为什么不能无限运行？

**关键词**：自然完成、maxIterations、未知工具、取消、流错误、成本。

```text
模型本轮没有工具调用时自然完成。除此之外默认最大 20 轮，连续三轮只请求未知工具会停止，AbortSignal 触发中断，Provider 流错误也会收尾。
这些条件避免模型幻觉或工具失败时无限消耗 token、反复执行副作用操作。
```

证据：[agent.ts](../../../../src/agent/agent.ts:15)、[agent.ts](../../../../src/agent/agent.ts:58)、[agent.ts](../../../../src/agent/agent.ts:74)。

### Q4. 工具结果为什么必须写回 Conversation？

**关键词**：无本机权限、因果链、tool_use、tool_result、下一轮。

```text
模型不会自动知道本机 ReadFile 的结果。QiCode 先保存 assistant 的 tool_use，再把 ToolResult 保存为 user 的 tool_result；下一轮 Provider 重新发送完整历史，模型才能基于真实结果决定下一步。
如果只保存文字或漏掉结果，模型无法得知动作是否成功，且某些 API 会因工具调用没有配对结果而拒绝请求。
```

证据：[agent.ts](../../../../src/agent/agent.ts:170)、[conversation.ts](../../../../src/conversation/conversation.ts:32)。

### Q5. 为什么连续只读工具可以并发，写入和命令必须串行？

**关键词**：副作用、顺序、吞吐、保序批次。

```text
ReadFile、Glob、Grep 一般不改变状态，连续出现时可以 Promise.all 缩短等待；WriteFile 和 Bash 可能修改相同文件或依赖前一个结果，所以各自独立成批，保持模型给出的相对顺序。
即使读批内完成顺序不同，我仍按调用顺序保存工具结果，保证 Conversation 的因果链稳定。
```

证据：[agent.ts](../../../../src/agent/agent.ts:176)、[agent.ts](../../../../src/agent/agent.ts:271)、[agent.test.ts](../../../../tests/agent/agent.test.ts:97)。

### Q6. Plan Mode 如何保证模型不会写文件？

**关键词**：提示词不可信、最小权限、工具过滤、执行层拦截。

```text
我不只依赖提示词。计划模式先向模型只发送 read 工具 schema，再由 PermissionChecker 在真正执行前检查 category，拒绝 write 和 command。
所以即使模型绕过提示词、幻觉出 WriteFile，本机也不会执行它，只会返回结构化错误结果。
```

证据：[checker.ts](../../../../src/permissions/checker.ts:5)、[agent.ts](../../../../src/agent/agent.ts:48)、[agent.ts](../../../../src/agent/agent.ts:211)。

### Q7. 取消如何跨越 TUI、网络和工具层？

**关键词**：AbortController、AbortSignal、向下传递、收尾。

```text
App 为一轮任务创建 AbortController；Esc 或忙碌时 Ctrl+C 调 abort。signal 随 AgentConfig 传给 Provider 的 fetch 和 ToolContext，Agent 每轮也检查 aborted 状态，停止后不再启动下一轮。
这样取消不是只隐藏 UI，而是中断底层等待并回到可继续对话的状态。
```

证据：[app.tsx](../../../../src/tui/app.tsx:69)、[app.tsx](../../../../src/tui/app.tsx:137)、[agent.ts](../../../../src/agent/agent.ts:39)。

诚实边界：自动化测试覆盖了 Loop 的取消分支设计，但真实终端 Esc/Ctrl+C 与真实模型的手工体验尚待验证。

### Q8. Provider 流不完整时，Loop 会有什么问题？怎么处理？

**关键词**：SSE 收尾、done、状态机、兜底。

```text
Loop 依赖一轮流结束后才判断是否执行工具。如果 Anthropic SSE 连接关闭却没发 message_stop，上层可能一直没有结束信号。
Provider 用 doneEmitted 记录正常结束；流自然结束但还没发 done 时补发一个 done，给上层一致的收尾语义。
```

证据：[anthropic.ts](../../../../src/providers/anthropic.ts:51)、[anthropic.ts](../../../../src/providers/anthropic.ts:150)、[anthropic.test.ts](../../../../tests/providers/anthropic.test.ts:105)。

### Q9. 如何控制多轮 Agent 的成本和上下文膨胀？

**关键词**：轮数上限、结果截断、当前局限。

```text
当前有两层基础控制：maxIterations 限制模型请求次数；单条工具输出在进入 Conversation 前截断到 10000 字符，避免一次工具输出占满后续上下文。
但它还没有做历史裁剪或摘要压缩，长会话仍可能超上下文。这是后续 Context 章节要解决的边界，不能宣称已完整解决。
```

证据：[agent.ts](../../../../src/agent/agent.ts:15)、[agent.ts](../../../../src/agent/agent.ts:302)。

### Q10. 如果改用 LangGraph，你的 Agent 如何映射？

**关键词**：StateGraph、节点、条件边、自研取舍。

```text
当前 Agent.run() 的 for 循环相当于状态图运行时；Provider.stream 是模型节点，executeTools 是工具节点，response.toolUses 是否为空相当于条件边，loop_complete 相当于 END，Conversation 是状态。
我选择先自研，是为了掌握 Coding Agent 的工具回灌、SSE 和终端取消等底层机制。以后做以检索循环为主的 RAG，再使用 LangGraph 的图运行时、checkpoint 和 store，会更贴合场景。
```

## 4. 追问应对

| 追问 | 回答方向 |
| --- | --- |
| 为什么未知工具不是第一次就停止？ | 先把结构化错误回给模型，它可能在下一轮纠正工具名；连续 3 轮才判定空转。 |
| 为什么未知工具在 Plan Mode 当作 command？ | 安全默认值。未知类别不能被当作 read 放行。 |
| 工具并发是否一定正确？ | 当前只并发连续只读工具，并假设它们无副作用；仍不解决数据依赖或读到并发写的复杂一致性。 |
| 结果按什么顺序写回？ | 按模型调用顺序，不按 Promise 实际完成顺序，保证下一轮历史可解释。 |
| Plan Mode 是否已经完成？ | 只完成最小只读限制；没有 UI 切换、ExitPlanMode 自动转换或交互式授权。 |
| 如何测试模型不稳定？ | 用 FakeProvider 固定每轮 StreamEvent，验证编排逻辑；真实 API 留给少量手工集成验收。 |

## 5. 简历表达

```text
QiCode | TypeScript, Node.js, Ink, SSE
- 设计有限 ReAct Agent Loop，将模型流式工具调用、工具执行与结果回灌编排为多轮任务，支持最大迭代、未知工具和流错误停止。
- 实现按工具副作用分批调度：连续只读并发、写入和 Shell 串行，并按调用顺序保存结果，保持跨轮会话一致性。
- 通过 AsyncGenerator 事件流解耦 Agent 与 Ink TUI，实现流式文本、工具状态、轮次及累计 token 展示；加入 AbortSignal 取消链路。
- 实现 Plan Mode 的最小权限边界：过滤非只读工具 schema，并在执行前二次拒绝写入/命令调用。
```

不要写“生产级安全 Agent”或“完整权限系统”。目前没有路径沙箱、交互式确认、持久化和上下文压缩。

## 6. 推荐学习顺序

1. 先读 [Debug 文档](../../study/Debug/03-loop/README.md)。
2. 再读 [agent.ts](../../../../src/agent/agent.ts:35) 的 `run()`，只追一条“Read -> Write -> 最终文本”主线。
3. 运行 `tests/agent/agent.test.ts`，观察 FakeProvider 的 `requests` 和 Conversation 变化。
4. 完成 Debug 文档里的三个故障实验。
5. 不看答案复述 Q1、Q4、Q5、Q6、Q7。

## 7. 独立练习

给 `AgentConfig` 增加 `unknownToolThreshold?: number`，默认仍是 3；写测试证明设为 2 时第二轮未知工具就停止。

完成后自己 Review：

- 默认值是否保持兼容？
- 已注册工具是否会重置未知工具计数？
- 新配置是否只影响 Agent，不泄漏到 Provider 或 Tool？
