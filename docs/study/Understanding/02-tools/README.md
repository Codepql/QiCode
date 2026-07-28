# 02-Tools 开发前认识与理解

> 本文用于阅读 `spec.md` 和 `plan.md` 后检查理解，不代替原始规划文档。
>
> 当前阶段只学习和确认理解，不编写源码。第 02 章尚未开发，文中的模块名来自规划；正式开发时以第 01 章真实代码为起点校准。

## 阅读范围

开发前先阅读：

- `docs/plan/02-tools/spec.md`
- `docs/plan/02-tools/plan.md`

再浏览：

- `docs/plan/02-tools/task.md`
- `docs/plan/02-tools/check.md`

阅读 `spec.md` 时，重点理解本章让 QiCode 新增什么能力、哪些危险能力暂时没有保护，以及本章与下一章 Agent Loop 的边界。

阅读 `plan.md` 时，重点理解工具层、Provider、Conversation、Agent 和 TUI 的职责。此时不需要记住六个工具的每个参数，也不需要背文件名。

`task.md` 用于确认实现顺序和覆盖范围，`check.md` 用于开发完成后的验收，不建议一开始逐条背诵。

## 本章定位

第 01 章完成的是“用户与模型对话”：

```text
用户输入 → Provider → LLM → 流式文本 → 用户看到回复
```

第 02 章要在这条链路中加入一次工具执行能力：

```text
用户输入
  ↓
模型决定调用工具
  ↓
QiCode 执行工具
  ↓
工具结果加入会话
  ↓
模型依据结果回答用户
```

这一步的价值不是“增加六个函数”，而是建立模型与本机能力之间的统一边界：模型只能提出结构化工具调用，真正的文件和进程操作由 QiCode 执行。

## 本章目标

- 建立统一 `Tool` 契约和 `ToolRegistry`。
- 提供 `ReadFile`、`WriteFile`、`EditFile`、`Bash`、`Glob`、`Grep` 六个工具。
- 将工具定义发送给 Anthropic 和 OpenAI 协议。
- 从两种协议的流式响应中组装完整工具调用参数。
- 执行模型请求的工具，并把成功或失败都转换为结构化结果。
- 将工具调用和结果写入 Conversation，供后续模型请求使用。
- 用协议无关的 Agent 事件编排一次工具闭环。
- 在 TUI 中显示工具名称、关键参数、执行状态和结果摘要。
- 对超时、长输出、找不到文件和错误命令进行可恢复处理。

本章完成后，QiCode 才开始具备 Coding Agent 的执行能力，但仍不是完整的自主 Agent。

## 本章明确不做什么

- 不做可以反复调用工具的多轮 Agent Loop；该能力属于第 03 章。
- 不做执行前授权确认、权限规则和路径沙箱。
- 不限制工具只能操作当前工作目录。
- 不做工具调用持久化和会话恢复。
- 不做运行时自定义工具、MCP 或 Skills。
- 不做工具结果的折叠、展开等复杂交互。
- 不做图片等多模态工具结果。

尤其需要知道：本章规划允许写文件和执行 Shell，却暂时没有权限确认和路径隔离。它适合本地学习和受控测试，不能把它描述成安全完善的生产级 Agent。

## 用户实际经历的流程

以用户输入“读取 `README.md` 并总结”为例：

```text
用户在 InputBox 提交请求
        ↓
App 把用户消息加入 Conversation
        ↓
Agent 从 ToolRegistry 取得六个工具定义
        ↓
Provider 把历史和工具定义转换为厂商请求
        ↓
LLM 流式返回工具名、调用 ID 和参数碎片
        ↓
具体 Provider 拼接碎片并输出统一工具调用事件
        ↓
Agent 收集完整的 ReadFile 调用
        ↓
StreamingExecutor 从 Registry 找到 ReadFile 并执行
        ↓
ReadFile 返回结构化 ToolResult
        ↓
Conversation 保存 assistant tool_use 和 user tool_result
        ↓
Provider 把工具结果按当前协议再次发给模型
        ↓
模型生成最终文本，TUI 展示工具行和回答
```

阅读本章时，需要抓住这条主线：

```text
Tool 契约 → Registry → Provider 协议映射
→ Agent 编排 → Conversation 回灌 → TUI 展示
```

## 真实架构边界

```text
main.tsx
  ↓
tui/App
  ├─→ Conversation：保存用户、助手、工具调用和工具结果
  ├─→ Agent：编排模型请求、工具执行和结果回灌
  │     ├─→ Provider：屏蔽 Anthropic / OpenAI 协议差异
  │     └─→ StreamingExecutor
  │            └─→ ToolRegistry
  │                   └─→ 六个 Tool
  └─→ ChatView / ToolDisplay：只负责终端展示
```

模块职责不能混淆：

- Tool 不解析 Anthropic 或 OpenAI 响应。
- Provider 不直接读写文件或运行命令。
- Agent 不包含六个工具的具体业务实现。
- Conversation 不执行工具，也不负责界面渲染。
- TUI 消费统一状态和事件，不判断厂商原始事件。

## 核心理解问题

### 1. 第 02 章解决了什么问题？

回答关键字：

```text
从“只会回答”到“能执行一次本机动作”
模型提出结构化调用、QiCode 执行、结果回灌
六个核心工具、单轮工具闭环
```

### 2. 为什么需要统一 Tool 接口？

回答关键字：

```text
name、description、schema、execute
统一发现和执行方式
Agent 不依赖具体工具类
方便注册、测试和以后扩展
```

### 3. ToolRegistry 负责什么，为什么不让 Agent 直接 new 六个工具？

回答关键字：

```text
集中注册、按名查找、列出工具、导出定义
发现与执行解耦
未知工具可返回结构化错误
避免 Agent 硬编码分支
```

### 4. 工具的 description、JSON Schema 和 execute 各给谁使用？

回答关键字：

```text
description：告诉模型何时使用
JSON Schema：约束模型传入参数形状
execute：QiCode 本地真实执行入口
Schema 不能代替运行时校验
```

### 5. 为什么工具调用参数需要流式拼接？

回答关键字：

```text
JSON 参数可能拆成多个 SSE 增量
Anthropic input_json_delta
OpenAI delta.tool_calls[index].function.arguments
按调用 ID / index 累积，完成后 JSON.parse
```

### 6. Provider 层在工具调用中负责什么？

回答关键字：

```text
统一工具定义 → 厂商请求格式
厂商流式事件 → 统一 tool_call 事件
统一历史 → tool_use / tool_result 或 tool_calls / tool
上层不感知协议差异
```

### 7. Agent、StreamingExecutor 和 Tool 分别负责什么？

回答关键字：

```text
Agent：控制一轮流程和状态顺序
StreamingExecutor：查找、执行、并发、兜底异常
Tool：完成一种具体本机操作
编排、调度、业务实现分离
```

### 8. 为什么工具失败也要作为结果回灌，而不是直接让程序报错退出？

回答关键字：

```text
工具失败是可预期业务结果
ToolResult.output + isError
模型可以解释或调整
单个工具失败不应破坏会话
TUI 同时显示失败状态
```

### 9. Conversation 为什么要保存 tool use 和 tool result？

回答关键字：

```text
下一次模型请求需要完整因果链
调用 ID 关联请求与结果
不同协议由 Provider 再翻译
只保存文本会丢失工具语义
```

### 10. 为什么第 02 章还不是完整 Agent Loop？

回答关键字：

```text
本章限制工具执行轮数
完整 Loop 需要反复“模型 → 工具 → 模型”
还要最大轮数、停止条件、取消、权限和上下文控制
第 03 章继续解决
```

## 开发前必须校准的规划冲突

当前文档存在一个不能靠实现细节绕开的冲突：

- `spec.md` 的 F6、AC8 和用户流程要求：工具结果回灌后，再请求模型生成最终文本。
- `task.md` 的 T15 和 `check.md` 的单轮上限要求：工具结果产生后立刻结束，且 Provider 只调用一次。

如果只调用一次 Provider，模型拿不到刚执行的工具结果，就无法依据文件内容生成最终总结。因此正式开发前必须统一“单轮闭环”的定义。

建议采用：

```text
一次用户请求最多执行一批工具
  ↓
结果回灌后允许第二次模型请求生成最终文本
  ↓
第二次请求即使再次要求工具，也不再执行
```

这既满足“读文件并总结”的用户体验，也把可反复执行工具的 Agent Loop 留给第 03 章。

另外，正式开发时还需按真实代码校准这些旧名称：

- 当前实现使用 `Provider`，不是规划中的 `client`。
- 当前文件是 `conversation/types.ts`、`tui/chat-view.tsx`、`prompt/system-prompt.ts`。
- 当前 `Provider.stream` 接收一个 `ChatRequest`，新增工具定义应继续放进该请求对象。
- 依赖版本以 `package.json` 和 `pnpm-lock.yaml` 为准，不按规划中的旧版本回退。
- `.QiCode` 的大小写沿用当前已经确认的行为。

## 开发前通过标准

开始第 02 章开发前，至少应当能够用自己的话说明：

1. 模型为什么不能直接操作文件，真正执行动作的是谁。
2. Tool、Registry、Provider、Agent、Conversation、TUI 各自负责什么。
3. 一次“读文件并总结”的完整数据流。
4. 为什么 JSON 工具参数需要按流式碎片拼接。
5. 工具错误为什么要结构化回灌。
6. 本章的单轮工具闭环与第 03 章 Agent Loop 有什么区别。
7. 本章暂时缺少哪些安全边界。

推荐学习流程：

```text
阅读 spec 和 plan
        ↓
沿用户流程画一遍架构图
        ↓
不看关键字回答 10 个问题
        ↓
让 Codex 检查理解
        ↓
先解决规划冲突并校准文件名
        ↓
按 separate 文档开始第 1 次开发
```
