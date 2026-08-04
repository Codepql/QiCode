# 04-Prompt Debug 学习文档：看懂 Agent 的指令如何稳定进入模型

> 适用代码：QiCode 第 04 章当前实现。`pnpm typecheck` 已通过；第 4-6 次修改后未运行自动化测试，也未使用真实 Anthropic/OpenAI 端点验证缓存命中，因此本文把这些内容列为待验证边界。

## 1. 本章解决了什么

第 03 章已经能循环调用模型和工具，但模型收到的系统提示仍是一段固定拼接文本。第 04 章把“Agent 应该怎样做事”拆成三条通道：

```text
固定规则 -> Section -> PromptBuilder -> systemPrompt
环境事实 -> EnvironmentContext --------> Environment Section
动态状态 -> system-reminder -----------> Conversation messages
```

这样做的核心不是让提示词更长，而是让职责更清楚：固定提示在同一会话中保持不变；Plan Mode 等运行状态进入消息历史；Anthropic/OpenAI 的缓存差异留在 Provider 层。

## 2. 架构地图

```text
App 初始化
  |-- createProvider(config)
  `-- detectEnvironment(workDir)
          |
          v
    EnvironmentContext + model
          |
          v
    buildSystemPrompt()
          |
          v
    AgentRuntime { provider, systemPrompt }  <- 同一会话复用

每次用户任务
  App.submit()
    -> Agent.run()
       |-- Plan Mode? addSystemReminder()
       |-- Provider.stream({ systemPrompt, messages, tools })
       |-- Anthropic: cache_control 断点
       `-- OpenAI: cached_tokens 映射

工具执行
  ReadFile 成功 -> readFiles.add(path)
  EditFile      -> 未读取则拒绝
```

## 3. 一次请求的数据变化

假设用户进入 `/plan`，然后要求分析一个重构：

```text
1. App 将 mode 改为 plan，固定 systemPrompt 不变。
2. 用户问题写入 Conversation。
3. Agent 第 1 轮生成完整 Plan reminder。
4. Conversation 将 reminder 包成：
   <system-reminder>...</system-reminder>
5. PermissionChecker 只向模型暴露 read 工具。
6. Provider 同时收到：
   - 稳定 systemPrompt
   - 用户问题与动态 reminder
   - 当前允许的工具 schema
7. Anthropic 对稳定前缀设置 cache_control；OpenAI 依赖相同消息前缀并解析 cached_tokens。
```

退出 `/do` 时只追加退出 reminder 并切回默认权限，不会重新生成 systemPrompt。

## 4. 核心模块四问

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
| --- | --- | --- | --- | --- |
| `src/prompt/sections.ts` | 定义固定提示模块和环境渲染 | Builder | 无 | 避免规则挤在一个大字符串里 |
| `src/prompt/builder.ts` | 排序、跳空、组装提示并探测环境 | App runtime 初始化 | Section、Node OS、Git | 保证装配规则统一且可扩展 |
| `src/prompt/plan-mode.ts` | 构造完整/精简/退出/重入提醒 | Agent、App | 文件存在性检测 | 把动态模式与固定提示分离 |
| `src/tui/app.tsx` | 创建并复用 AgentRuntime，处理 `/plan`、`/do` | Ink | Builder、Agent、Provider | 保证同一会话的 systemPrompt 稳定 |
| `src/conversation/conversation.ts` | 包装并保存 system-reminder | Agent、App | 消息数组 | 让动态上下文进入统一历史 |
| `src/llm/anthropic.ts` | 设置显式缓存断点并解析缓存用量 | Agent | Anthropic HTTP/SSE | 隔离 Anthropic 协议细节 |
| `src/llm/openai.ts` | 保持 system 前缀并解析 cached token | Agent | OpenAI HTTP/SSE | 隔离 OpenAI usage 字段 |
| `src/tools/descriptions.ts` | 在工具局部说明中重复关键规则 | Tool schema | 无 | 模型选工具时再次看到约束 |
| `src/tools/read-file.ts` / `edit-file.ts` | 登记读取并执行先读后改检查 | Agent Executor | 文件系统 | 提示词之外再加代码级保护 |

## 5. 关键状态

| 状态 | 正常值 | 作用 |
| --- | --- | --- |
| `Section.priority` | 0、10...70，扩展槽为 90/95/100 | 决定最终提示顺序 |
| `EnvironmentContext.model` | 当前选择的模型名 | 让模型知道自身运行配置 |
| `runtimeRef.current` | 同一会话同一个 Promise | 防止每个用户回合重建提示 |
| `mode` | `default` / `plan` | 决定工具权限与 reminder |
| `iteration` | 1 开始 | 第 1、6、11...轮使用完整提醒 |
| `UsageInfo.cacheReadInputTokens` | Provider 返回值或 0 | 表示缓存读取 token |
| `UsageInfo.cacheCreationInputTokens` | Anthropic 返回值或 0 | 表示缓存创建 token |
| `Agent.#readFiles` | 已成功读取的绝对路径集合 | EditFile 执行前置条件 |

## 6. 推荐断点路线

### D1：环境信息在哪里产生

- 断点：[builder.ts](../../../../src/prompt/builder.ts:42) 的 `detectEnvironment()`。
- 观察：`workDir`、`environment.isGitRepo`、`environment.gitBranch`。
- 异常含义：Git 命令失败时应返回基础环境，而不是终止启动。

### D2：系统提示在哪里固定下来

- 断点：[app.tsx](../../../../src/tui/app.tsx:54) 的 `initializeAgentRuntime()`。
- 观察：`detectedEnvironment`、`environment.model`、`systemPrompt`。
- 再看：[app.tsx](../../../../src/tui/app.tsx:94) 的 `runtimeRef`。
- 要证明：第二个用户回合仍使用同一个 runtime。

### D3：Section 怎样排序

- 断点：[builder.ts](../../../../src/prompt/builder.ts:27) 的 `build()`。
- 观察：排序前后的 `sections`、trim 后的 content。
- 异常含义：空 Section 不应产生多余空行。

### D4：Plan reminder 怎样进入历史

- 断点：[agent.ts](../../../../src/agent/agent.ts:54)。
- 再进：[conversation.ts](../../../../src/conversation/conversation.ts:43)。
- 观察：`iteration`、`planPath`、最新一条 message。
- 要证明：动态提醒没有修改 `systemPrompt`。

### D5：为什么 Plan Mode 不只是提示词

- 断点：[agent.ts](../../../../src/agent/agent.ts:65) 与 [agent.ts](../../../../src/agent/agent.ts:227)。
- 观察：发送给模型的 tools 和 `permissionChecker.allows(category)`。
- 要证明：写入/命令工具既不暴露，也不能执行。

### D6：Anthropic 缓存断点

- 断点：[anthropic.ts](../../../../src/llm/anthropic.ts:153) 的 `buildRequestBody()`。
- 观察：`system[0].cache_control`、最后一个 tool、最后一条 user content 尾块。
- 正常值：三处均为 `{ type: "ephemeral" }`。

### D7：OpenAI 缓存 token 如何避免双计

- 断点：[openai.ts](../../../../src/llm/openai.ts:81)。
- 观察：`promptTokens`、`cacheReadInputTokens`、最终 `inputTokens`。
- 正常关系：`inputTokens = max(0, promptTokens - cacheReadInputTokens)`。

### D8：先读后改如何落到代码

- 断点：[read-file.ts](../../../../src/tools/read-file.ts:46) 和 [edit-file.ts](../../../../src/tools/edit-file.ts:45)。
- 观察：`absolutePath`、`ctx.readFiles`。
- 要证明：模型忽略 description 时，执行层仍能拒绝未读取的编辑。

## 7. 故障注入实验

### 实验 1：Git 不可用

- 制造：把 `detectEnvironment()` 的 Git 命令临时改为不存在的命令。
- 预期：`isGitRepo=false`、`gitBranch=""`，仍能生成提示。
- 学到：环境感知是增强信息，不应成为启动硬依赖。

### 实验 2：每回合重建 runtime

- 制造：临时绕过 `runtimeRef`，每次 submit 都调用 `initializeAgentRuntime()`。
- 观察：两次 `systemPrompt` 是否因日期、Git 或配置变化而不同。
- 学到：稳定提示要求生命周期设计，不只是字符串函数确定性。

### 实验 3：Plan reminder 频率错误

- 制造：把 [plan-mode.ts](../../../../src/prompt/plan-mode.ts:37) 的间隔条件改成 `iteration % 5 === 0`。
- 预期：完整版会落到第 5 轮而不是第 6 轮。
- 学到：边界公式必须从期望序列 1、6、11 反推。

### 实验 4：删除 Anthropic system 缓存断点

- 制造：临时移除 `system[0].cache_control`。
- 预期：功能仍能回答，但真实端点的缓存创建/读取可能下降。
- 学到：缓存是性能能力，不是正确性能力。

### 实验 5：OpenAI cached token 大于 prompt token

- 制造：模拟 `prompt_tokens=10`、`cached_tokens=20`。
- 预期：普通 input token 被钳制为 0，不出现负数。
- 学到：第三方 usage 数据必须在边界处防御。

### 实验 6：未读取直接 EditFile

- 制造：同一个 Agent 任务第一步直接请求 EditFile。
- 预期：返回“编辑前必须先使用 ReadFile”，文件不变。
- 学到：提示词约束和执行层安全不是同一件事。

## 8. 当前局限

- 尚未用真实 Provider 证明缓存创建与缓存读取大于 0。
- 第 4-6 次改动后未运行完整自动化测试，现有部分英文 Plan Mode 断言可能需要同步为中文。
- `.QiCode/plan.md` 目前只有路径和存在性检测，没有专用 Plan 文件管理器。
- Skill、自定义指令和 Memory 只有 Builder 槽位，尚未接入真实来源。
- `readFiles` 只在单个 Agent 实例内有效；不同路径别名或符号链接可能要求重新读取。
- 提示词和工具 description 不是权限系统；真正的危险命令确认和路径沙箱属于后续章节。

## 9. 掌握标准

你能不看代码完成以下事情，就算掌握第 04 章：

- 画出固定提示、环境信息、动态 reminder 三条通道。
- 解释 systemPrompt 为什么按会话固定，而不是按 iteration 重建。
- 断点观察一次 Anthropic 请求的三个缓存断点。
- 解释 OpenAI cached token 为什么从普通 input token 中扣除。
- 说明 Plan Mode 和先读后改为什么都需要代码级兜底。
- 诚实区分“已实现缓存协议”与“已验证真实缓存收益”。
