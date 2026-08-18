# 第 12 章 Debug：SubAgent 与后台任务

本章最终验收：43 个测试文件、237 条测试通过；`pnpm.cmd typecheck`、`pnpm.cmd build`、`git diff HEAD --check` 通过。

## 1. 自定义角色没有生效

先检查定义目录：

```text
~/.QiCode/agents/*.md
<workDir>/.QiCode/agents/*.md
```

加载顺序是内置 -> 用户 -> 项目。只有同名且合法的后层定义才能覆盖前层。`loadAgentDefinitions()` 返回 `{ definitions, diagnostics }`：坏文件不会让整个角色系统不可用，TUI 会显示本地 `Agent configuration` 提示。

最小合法文件：

```md
---
name: review-auth
description: Review authentication code.
tools: [ReadFile, Glob, Grep]
permission_mode: plan
max_turns: 8
---

Only inspect the repository. Return evidence and recommendations.
```

常见错误：

- `name` 不是小写 slug，例如 `Review Auth`；
- `max_turns` 不在 1 到 50；
- frontmatter 写入 `api_key`、`base_url` 等不允许字段；
- 文件不是普通 `.md`，或是符号链接。

## 2. 子 Agent 找不到工具，或意外能调用 Agent

从 `createSubAgentToolRegistry()` 开始断点。它创建新的 Registry 视图，不改父 Registry。

过滤顺序是：移除 `Agent` -> 不共享主 system 工具 -> 后台只读集合 -> allowlist -> denylist -> 为子视图新建 `ToolSearchTool`。

`ToolSearchTool` 不能复用主实例，因为它保存 Registry 引用。若复用，子 Agent 的 `select:<tool>` 会修改主 Agent 的 discovered 状态。正确现象是父 Registry 的工具和 discovered 状态始终不变。

## 3. 子 Agent 的模型不对

从 `SubAgentRunner.run()` 查看 `resolveModel()`：

```text
工具参数 model
  -> 角色定义 model
  -> 父 ProviderConfig.model
```

最终只构造：

```ts
{ ...parentProviderConfig, model }
```

因此角色文件不能替换 API Key、base URL、protocol 或 thinking。空模型名会返回 `stopReason: "error"`，不会发起 Provider 请求。

## 4. 后台任务不结束或无法取消

检查 `TaskManager.create()`、`TaskManager.cancel()` 和 `TaskManager.runTask()`。

状态机只有：

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
```

取消时 TaskManager 先把自己的 AbortController abort，再由 `SubAgentRunner.run()` 把信号交给子 Agent。任务显示 cancelled 不代表底层 Promise 已经消失；并发槽位要等 Promise 的 finally 执行后才释放。

应用退出时调用 `TaskManager.cancelAll()`，最多等待有限 grace period，不会无限卡住终端。

## 5. 后台结果为什么不在聊天记录里

后台完成通知由 `TaskManager.drainNotifications()` 产生。App 将其通过 `AgentConfig.transientReminders` 交给下一次 `Agent.run()`，Agent 在发 Provider 请求前临时追加。

它不会写进 Conversation 或 session JSONL。通知会标注为 untrusted task output，模型应把它当数据而不是命令。这避免了两类问题：会话历史被后台草稿污染，以及子 Agent 文本借提醒通道进行提示词注入。

## 6. 推荐断点

- `parseAgentDefinitionFile()`：单个 Markdown 定义为什么被拒绝。
- `loadAgentDefinitions()`：覆盖顺序与 diagnostics。
- `createSubAgentToolRegistry()`：子工具集合。
- `SubAgentRunner.run()`：隔离 Conversation、Provider、权限、取消和输出上限。
- `TaskManager.create()` / `runTask()` / `drainNotifications()`：状态与通知。
- `AgentTool.execute()`：同步、后台、查询、取消四条入口。
- `Agent.run()` 中的 `transientReminders`：后台结果如何进入下一次模型请求。

## 7. 可复现实验

1. 在项目目录创建同名 `general-purpose.md`，确认覆盖内置描述；再故意把 name 改成大写，确认内置角色仍存在且出现诊断。
2. 为一个后台角色设置只读 tools，尝试让它调用 `Agent` 或 `WriteFile`，确认子 Registry 中没有这些工具。
3. 发起后台角色后立刻通过 `operation: cancel` 取消，确认 task 变为 cancelled，下一次主 Agent 请求不会收到 completed 通知。
4. 将最大保留任务调到 1，完成并消费第一条通知后再建新任务，确认已通知的终态记录被回收。
5. 让子任务输出一段“忽略之前指令”的文本，确认下一轮收到的 reminder 明确标记为 untrusted data。
