# 02-Tools Debug 学习文档：把一次工具调用走通

> 适用代码：QiCode 第 02 章当前实现。先看流程，再看函数；不要一开始逐行读代码。

## 1. 本章完成了什么

QiCode 现在不只是“问模型、显示回答”。模型可以请求六个本地工具：`ReadFile`、`WriteFile`、`EditFile`、`Bash`、`Glob`、`Grep`。

本章的边界是：一条用户消息最多执行一批工具。工具结果会回传给模型，模型再流式生成最终回答；如果第二次回答还想调用工具，只显示上限错误，不执行第二批。真正的多轮 Agent Loop 留给第 03 章。

## 2. 架构地图

```text
用户输入
  |
  v
App.submit()                         src/tui/app.tsx
  |-- Conversation.addUserMessage()
  |-- createToolRegistry()           注册 6 个工具
  `-- Agent.run()
         |
         | 第一次模型请求
         v
       Provider.stream()
         |-- AnthropicProvider / OpenAIProvider
         |-- SSE 分片 -> 统一 StreamEvent
         `-- tool_call_complete { 工具名, 参数 }
         |
         v
       StreamingExecutor
         |-- ToolRegistry.get(工具名)
         `-- Promise.all 执行本批工具
         |
         v
       Conversation.addToolResultsMessage()
         |
         | 第二次模型请求，只生成最终文本
         v
       Provider.stream()
         |
         v
       App / ChatView / ToolDisplay
```

你应该先能复述这张图：**App 负责协调；Provider 翻译协议；Agent 编排闭环；Registry 找工具；Tool 执行真实动作；Conversation 保存下一次请求要带上的历史；TUI 只显示事件。**

## 3. 模块四问

阅读每个文件都问：它负责什么？谁调用它？它调用谁？为什么需要它？

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么单独存在 |
| --- | --- | --- | --- | --- |
| `src/tui/app.tsx` | 收到输入、创建 Agent、消费事件并更新界面 | Ink / `main.tsx` | Conversation、Agent、Registry | UI 不需要知道协议 JSON 或文件系统细节 |
| `src/agent/agent.ts` | 一批工具的闭环编排 | `App.submit()` | Provider、Executor、Conversation | 将业务流程从 React 组件中移出，能独立测试 |
| `src/agent/streaming-executor.ts` | 查找并并发执行已经完整的工具调用 | Agent | ToolRegistry、具体 Tool | 把“执行工具”与“请求模型”分开 |
| `src/tools/registry.ts` | 按名字管理工具、导出 schema | App、Agent | Tool 接口 | Provider 和 Agent 不必依赖六个具体工具类 |
| `src/tools/*.ts` | 读、写、改、命令、找文件、搜内容 | StreamingExecutor | Node 文件系统 / 子进程 / fast-glob | 每种副作用和错误处理不同，不能塞进一个大文件 |
| `src/llm/anthropic.ts` | Anthropic 请求、工具 JSON 分片拼接、历史映射 | Agent | SSE、HTTP | 隔离 Anthropic 格式和 thinking 规则 |
| `src/llm/openai.ts` | OpenAI/兼容端点请求、工具 JSON 分片拼接、历史映射 | Agent | SSE、HTTP | 隔离 `delta.tool_calls` 格式 |
| `src/conversation/conversation.ts` | 保存 user、assistant、tool use、tool result | App、Agent、Provider | 消息类型 | “显示在屏幕上”不等于“下一轮发给模型” |
| `src/tui/chat-view.tsx` | 从历史与动态状态渲染正文和工具块 | App | ToolDisplay、Markdown | 让展示规则不污染 Agent |

## 4. 一次“读取 README 并总结”的真实流程

```text
1. 用户输入“读取 README.md 并总结”
2. App.submit() 把用户消息加入 Conversation
3. Agent.run() 调用 Provider.stream({ messages, tools })
4. Provider 收到流式工具调用分片，拼成：
   { toolName: "ReadFile", arguments: { file_path: "README.md" } }
5. Agent 发出 tool_use 事件，TUI 显示运行中工具
6. StreamingExecutor 找到 ReadFileTool 并执行
7. Agent 将结果截断到最多 10000 字符，写入 Conversation
8. Agent 第二次调用 Provider.stream()，这次历史已包含 tool_use 和 tool_result
9. 模型读到结果，流式输出总结
10. App 将最终文本提交为正式 assistant 消息
```

关键点：模型并没有直接读取本地文件。它只会发出一个“想调用 ReadFile”的结构化请求；真正读文件的是 QiCode 本地进程。

## 5. 核心断点路线

用 VS Code 的 JavaScript Debug Terminal 启动 `pnpm dev`。每次只打一个断点，观察变量后再继续。

### D1. 用户输入如何进入 Agent

- 断点：[app.tsx](../../../src/tui/app.tsx:97) 的 `submit()`。
- 观察：`rawText`、`busy`、`conversationRef.current.getMessages()`。
- 证明：用户消息先被保存，再调用模型；TUI 的 `messages` 只是用于渲染的副本。

### D2. 六个工具在哪里注册

- 断点：[app.tsx](../../../src/tui/app.tsx:199) 的 `createToolRegistry()`。
- 观察：`registry.listTools()`。
- 证明：具体工具集中在组合根注册，Agent 只依赖 `ToolRegistry`。

### D3. 模型工具调用如何从 SSE 变成参数对象

- Anthropic：断点 [anthropic.ts](../../../src/llm/anthropic.ts:101)，观察 `argumentsDelta` 和 `toolCalls`。
- OpenAI：断点 [openai.ts](../../../src/llm/openai.ts:93)，观察 `deltaToolCalls`、`index`、`argumentsJson`。
- 证明：网络可能把 `{"file_path":"README.md"}` 拆成多段；Provider 必须累计分片，不能每段直接 `JSON.parse()`。

### D4. Agent 何时决定执行工具

- 断点：[agent.ts](../../../src/agent/agent.ts:28) 的 `run()`，再进入 [agent.ts](../../../src/agent/agent.ts:123) 的 `tool_call_complete` 分支。
- 观察：`firstResponse.toolUses`。
- 证明：Provider 不执行工具；Provider 只产生统一事件，Agent 才做业务决策。

### D5. 工具如何被找到、执行和保护

- 断点：[streaming-executor.ts](../../../src/agent/streaming-executor.ts:42) 的 `execute()`。
- 观察：`call.toolName`、`tool`、`call.args`、`result`、`elapsed`。
- 证明：未知工具和工具抛出的异常都会转成 `{ output, isError: true }`，而不是令整个对话崩溃。

### D6. 为什么要截断工具结果

- 断点：[agent.ts](../../../src/agent/agent.ts:204) 的 `truncateToolOutput()`。
- 观察：`output.length`、返回值长度。
- 证明：界面截断是为阅读；Agent 截断是保护下一次模型上下文和成本。这是两层不同保护。

### D7. 第二次请求为什么能总结文件内容

- 断点：[agent.ts](../../../src/agent/agent.ts:76) 的第二次 `streamResponse()`，再进 [conversation.ts](../../../src/conversation/conversation.ts:32)。
- 观察：第二次请求的 `messages`，其中应有 assistant 的 `tool_use` 和 user 的 `tool_result`。
- 证明：模型“看到”文件内容的方式是 QiCode 显式把工具结果放进历史，而不是模型拥有本机权限。

### D8. 工具行为什么会显示在终端

- 断点：[app.tsx](../../../src/tui/app.tsx:141) 的 `tool_use` 分支，接着看 [chat-view.tsx](../../../src/tui/chat-view.tsx:45)。
- 观察：`activeTools`、`messages`、`toolResults`。
- 证明：运行中的工具来自临时 `activeTools`；完成后的工具数据来自 Conversation 历史。

## 6. 亲手制造错误

每次都按“预测 -> 制造 -> 断点观察 -> 恢复”四步做，不要在重要目录测试写文件和 Bash。

### 实验 1：模型请求未知工具

- 制造：在 [tests/agent/agent.test.ts](../../../tests/agent/agent.test.ts:34) 的 fake 事件中把 `ReadFile` 改成 `Nope`。
- 断点：`StreamingExecutor.execute()`。
- 预期：没有崩溃；结果是结构化错误，仍会进入第二次模型请求。
- 学到：为什么工具失败不能直接 throw 到 TUI。

### 实验 2：ReadFile 路径不存在

- 制造：让模型读取一个不存在的文件，或直接运行 `ReadFileTool.execute({ file_path: "not-found.txt" }, ctx)`。
- 断点：[read-file.ts](../../../src/tools/read-file.ts:52)。
- 预期：返回 `isError: true`；下一轮仍可以继续聊天。
- 学到：工具错误是模型可理解的数据，不是进程级异常。

### 实验 3：EditFile 无法唯一匹配

- 制造：创建有两处相同文字的测试文件，再不传 `replace_all` 调用 EditFile。
- 断点：[edit-file.ts](../../../src/tools/edit-file.ts:47)。
- 预期：不写文件，返回命中次数与解决建议。
- 学到：修改工具为什么要用“唯一匹配”而不是静默替换第一处。

### 实验 4：工具参数 JSON 被拆包

- 制造：查看 [tests/llm/openai.test.ts](../../../tests/llm/openai.test.ts:56)，将参数拆成更多段。
- 断点：`OpenAIProvider.stream()` 的 `argumentsJson += argumentsDelta`。
- 预期：最终 `tool_call_complete.arguments` 仍是完整对象。
- 学到：流式传输中“事件已到”不代表“参数已完整”。

### 实验 5：超时 Bash

- 制造：运行已有的超时测试，或在测试目录让 Bash 执行 5 秒 Node 定时器但传 `timeout: 1`。
- 断点：[bash.ts](../../../src/tools/bash.ts:118)。
- 预期：约一秒返回超时错误，Agent 不被永久阻塞。
- 学到：为什么超时回调既尝试终止进程，也立刻结束 Promise；Windows 进程树回收可能不是瞬时的。

### 实验 6：超大工具输出

- 制造：阅读 [tests/agent/agent.test.ts](../../../tests/agent/agent.test.ts:105)，把 fake 工具输出改为更长字符串。
- 断点：`truncateToolOutput()`。
- 预期：写进历史和发给 TUI 的结果最多 10000 字符，末尾有截断提示。
- 学到：输入/输出边界控制同时保护 token 成本和稳定性。

## 7. 用测试理解架构

最值得先读的不是所有工具测试，而是 [tests/agent/agent.test.ts](../../../tests/agent/agent.test.ts:10)。它用 `FakeProvider` 模拟模型，不需要真实 Key，就验证了四个核心场景：

1. 无工具时，流式文本被保存。
2. 有工具时，第一次请求 -> 工具 -> 结果回灌 -> 第二次最终回答。
3. 第二次仍请求工具时，系统拒绝执行第二批。
4. 超大工具输出会被截断。

然后读两个 Provider 测试：[tests/llm/anthropic.test.ts](../../../tests/llm/anthropic.test.ts:66) 和 [tests/llm/openai.test.ts](../../../tests/llm/openai.test.ts:56)。它们证明两种协议虽然 JSON 不同，但都能输出同一种 `StreamEvent`。

## 8. 本章完成标准

你不需要背全部代码。能够完成以下事情，就说明真正掌握了第 02 章：

- 不看源码画出第 2 节的流程。
- 用四问讲清 `Agent`、`Provider`、`ToolRegistry`、`Conversation`。
- 断点证明工具参数是分片累计出来的。
- 断点证明工具结果进入了第二次模型请求。
- 完成至少三个故障实验，并解释现象、根因和恢复方式。
- 能说出本章限制：没有权限确认、路径沙箱、危险命令拦截和多轮 Agent Loop。
