# 03-Loop Debug 学习文档：看懂 QiCode 如何自己连续干活

> 适用代码：QiCode 第 03 章当前实现。自动化验证：23 个测试文件、120 个测试通过。真实 Provider、终端取消与窄终端体验仍需要你亲自验证。

## 1. 本章解决了什么

第 02 章只能完成“一批工具 -> 再问一次模型”。如果模型在第二次回答里又想调用工具，就会停住。

第 03 章把这个固定流程改成有限循环：

```text
问模型
  -> 模型要工具？
     -> 是：执行工具、把结果放回历史、进入下一轮
     -> 否：文本就是最终回答，结束
```

为了防止模型失控，还增加了最大 20 轮、连续 3 轮未知工具、流错误和取消等停止条件。

## 2. 架构地图

```text
用户输入
  |
  v
App.submit()                         src/tui/app.tsx
  |
  v
Agent.run()                          src/agent/agent.ts
  |-- iteration_start
  |-- Provider.stream()              模型流式回答
  |-- 文字/工具调用 -> AgentEvent
  |-- executeTools()
  |     |-- 连续 read 工具：并发一批
  |     `-- write / command：依次单独执行
  |-- Conversation 写入 tool_use / tool_result
  `-- 下一轮，或 loop_complete
  |
  v
App 消费事件 -> ChatView / Activity / StatusBar
```

请先记住分工：**Provider 和模型通信；Agent 决定任务是否继续；Executor 执行工具；Conversation 保存因果链；App 只显示事件。**

## 3. 一次多轮任务的数据变化

用户说：“读取 `README.md`，根据内容新建 `summary.md`，然后告诉我完成了什么。”

```text
第 1 轮
Conversation: [user 问题]
Provider:     请求 ReadFile
Conversation: [user, assistant(tool_use ReadFile), user(tool_result)]

第 2 轮
Provider:     看见读取结果，请求 WriteFile
Conversation: [..., assistant(tool_use WriteFile), user(tool_result)]

第 3 轮
Provider:     看见写入结果，返回最终文本
Conversation: [..., assistant(最终文本)]
```

关键点：模型不是“自己记得文件内容”，而是 QiCode 每轮把 `Conversation.getMessages()` 再发送给模型。

## 4. 核心模块四问

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
| --- | --- | --- | --- | --- |
| `src/agent/agent.ts` | 多轮循环、停止条件、工具调度、结果回灌 | `App.submit()` | Provider、Executor、Conversation、Checker | 不让 TUI 承担业务编排 |
| `src/agent/events.ts` | 定义 Agent 能发送的统一事件 | Agent、App | 无 | 编译期约束 Agent 和界面的沟通 |
| `src/agent/streaming-executor.ts` | 查找并执行一个工具调用 | Agent | Registry、具体 Tool | 把本机执行和模型通信隔离 |
| `src/permissions/checker.ts` | 判断当前模式能否执行某类工具 | Agent | 无 | Plan Mode 不只靠提示词，而有本地限制 |
| `src/prompt/plan-mode.ts` | 生成计划模式提醒 | Agent | 无 | 告诉模型当前只能检查和规划 |
| `src/tui/app.tsx` | 消费事件、维护终端状态、取消当前任务 | Ink | Agent、Conversation | UI 不判断 Loop 下一步 |

## 5. 断点路线

用 VS Code 的 JavaScript Debug Terminal 启动 `pnpm dev`。每次只打一个断点，观察后继续。

### D1：一轮从哪里开始

- 断点：[agent.ts](../../../../src/agent/agent.ts:35) 的 `run()`。
- 观察：`iteration`、`maxIterations`、`consecutiveUnknownToolTurns`。
- 你会看到：每一轮先 `yield iteration_start`，再请求模型。

### D2：为什么模型会进入下一轮

- 断点：[agent.ts](../../../../src/agent/agent.ts:58)。
- 观察：`response.toolUses.length`。
- 值为 `0`：模型给了最终文本，Loop 结束；大于 `0`：执行工具后回到 `for` 循环顶部。

### D3：模型流如何变成统一事件

- 断点：[agent.ts](../../../../src/agent/agent.ts:96) 的 `streamResponse()`。
- 再进：[agent.ts](../../../../src/agent/agent.ts:114) 的 `recordEvent()`。
- 观察：Provider 的 `StreamEvent` 与返回的 `AgentEvent`。
- 证明：Agent 不理解 Anthropic/OpenAI 原始 JSON，只理解统一事件。

### D4：工具为什么会先读后写

- 断点：[agent.ts](../../../../src/agent/agent.ts:271) 的 `createExecutionBatches()`。
- 观察：`toolUses` 和 `batches`。
- 例子：`ReadFile, Grep, WriteFile, Bash` 会变成 `[[ReadFile, Grep], [WriteFile], [Bash]]`。

### D5：Plan Mode 的双重限制

- 断点：[agent.ts](../../../../src/agent/agent.ts:47) 与 [agent.ts](../../../../src/agent/agent.ts:211)。
- 观察：`permissionChecker.mode`、发送给 Provider 的 `tools`、`category`。
- 证明：Plan Mode 先不把写入/命令工具告诉模型；即使模型仍幻觉调用，本地执行层也返回错误结果。

### D6：工具结果怎样进入下一轮

- 断点：[agent.ts](../../../../src/agent/agent.ts:170)。
- 再进：[conversation.ts](../../../../src/conversation/conversation.ts:32)。
- 观察：`resultBlocks` 和 `conversation.getMessages()`。
- 证明：每个 `tool_use` 都有对应 `tool_result`，否则下轮 API 可能拒绝历史。

### D7：为什么终端能显示轮次和累计 token

- 断点：[app.tsx](../../../../src/tui/app.tsx:147)。
- 观察：`event.type`、`iteration`、`inputTokens`、`outputTokens`。
- 重点：[app.tsx](../../../../src/tui/app.tsx:171) 用旧值加本轮值，而不是覆盖。

### D8：Provider 流缺结束事件怎么办

- 断点：[anthropic.ts](../../../../src/llm/anthropic.ts:150)。
- 观察：`doneEmitted`。
- 证明：即使服务端异常地没发 `message_stop`，Provider 也补一个 `done`，Loop 不会无限等待。

## 6. 亲手制造故障

只在测试代码或临时目录操作，每次遵循“预测 -> 制造 -> 断点 -> 恢复”。

### 实验 1：模型反复要求工具

- 制造：在 [agent.test.ts](../../../../tests/agent/agent.test.ts:48) 的 `FakeProvider` 中每轮都返回 `ReadFile`；把 `maxIterations` 设为 `2`。
- 预期：第 2 轮后收到 `max_iterations`，不再请求模型。
- 学到：最大轮次控制成本与死循环，不是 Provider 的责任。

### 实验 2：模型连续请求未知工具

- 制造：把工具名改成未注册的 `NotRegistered`。
- 断点：[agent.ts](../../../../src/agent/agent.ts:67)。
- 预期：每轮有结构化工具错误；连续第 3 轮后停止。
- 学到：工具错误可以回给模型，但编排层仍要阻止空转。

### 实验 3：Provider 在流中报错

- 制造：阅读 [agent.test.ts](../../../../tests/agent/agent.test.ts:71) 的 `ThrowingProvider`，让它先返回一点文本再抛错。
- 预期：已有文本保留；未配对的工具调用不写入历史；Loop 以 `error` 结束。
- 学到：异常收尾最重要的是保持 Conversation 合法。

### 实验 4：读工具并发、写工具等待

- 制造：看 [agent.test.ts](../../../../tests/agent/agent.test.ts:97)，给 `recordingTool` 增加不同延迟。
- 预期：两个 read 先后都开始，再结束；write 在它们之后开始。
- 学到：并发只发生在连续只读批，不能跨越写入/命令。

### 实验 5：Plan Mode 中请求 WriteFile

- 制造：看 [agent.test.ts](../../../../tests/agent/agent.test.ts:118)，让 FakeProvider 请求 `WriteOne`。
- 预期：`execute()` 根本不运行；模型得到 `Plan mode does not allow write tools.`。
- 学到：提示词不是安全边界，本地检查才是。

### 实验 6：Anthropic 流提前关闭

- 制造：看 [anthropic.test.ts](../../../../tests/llm/anthropic.test.ts:105)，模拟没有 `message_stop` 的 SSE。
- 预期：末尾仍得到 `{ type: "done" }`。
- 学到：流协议必须有收尾兜底，否则上层状态机可能卡住。

## 7. 用测试理解本章

优先读 [agent.test.ts](../../../../tests/agent/agent.test.ts:12)。它不需要 API Key，用 FakeProvider 固定“每一轮模型会说什么”，验证：

1. 纯文本第一轮结束。
2. ReadFile -> WriteFile -> 最终文本的三轮流程。
3. 最大轮次与未知工具停止。
4. 流错误时历史仍合法。
5. 结果截断、只读并发/写入串行、Plan Mode 拒绝写入。

再读 [anthropic.test.ts](../../../../tests/llm/anthropic.test.ts:105)，理解 Provider 的收尾事件为什么是 Loop 的前置条件。

## 8. 当前局限与完成标准

尚未完成：交互式权限确认、路径沙箱、Plan Mode 自动退出并执行、上下文压缩、持久化、子 Agent。

真实手工验证仍待完成：真实模型多轮任务、Esc/Ctrl+C 取消后继续对话、窄终端展示、Anthropic 跨协议一致性。

你能完成以下事情，就算掌握第 03 章：

- 不看代码画出第 2 节架构图。
- 解释“工具调用后为什么会进入下一轮”。
- 断点看到 Conversation 从问题变成多轮因果链。
- 完成至少三个故障实验，并说出根因和修复位置。
- 能说明 Plan Mode 为什么需要“模型可见工具过滤 + 本地二次拦截”。
