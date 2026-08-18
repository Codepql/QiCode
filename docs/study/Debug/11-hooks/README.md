# 第 11 章 Debug：Hook 生命周期系统

本章验收结果：38 个测试文件、222 条测试全部通过；`pnpm.cmd typecheck`、`pnpm.cmd build` 和 `git diff --check` 通过。

## 1. Hook 不生效

先确认配置文件位置：

```text
~/.QiCode/config.yaml
<项目>/.QiCode/config.yaml
<项目>/.QiCode/config.local.yaml
```

`loadConfigLayers()` 只负责读取和合并原始 `hooks` 数组。真正把坏规则筛掉的是 `validateHooks()`。因此配置中某一条写错时，不是整个应用停止，而是 TUI 显示类似：

```text
Hook configuration: hooks[1]: invalid event 'before_model'
```

排查顺序：

1. 检查 `event` 是否属于 `HOOK_EVENTS`。
2. 检查 `action.type` 是否为 `command/prompt/http/agent`。
3. 检查对应字段是否存在，例如 command 必须有 `command`，http 必须有 `url`。
4. 检查 `reject` 是否只用于 `pre_tool_use`。

## 2. Prompt Hook 看起来执行了两次

`HookEngine.fire()` 会把 prompt 输出放入通知队列。`Agent.run()` 在一次请求开始前调用 `drainNotifications()`，并通过 `Conversation.systemReminderMessage()` 临时追加到本次 Provider 请求。

这段 reminder 不会写回 `Conversation`，因此：

- 当前请求能看到 Hook 提示；
- 下一次请求不会自动重复，除非 Hook 再次触发；
- `/clear` 不需要额外清理 Hook 文本；
- session JSONL 不会保存 Hook 提示。

如果看到重复，重点检查是否在 App 中每次 `submit()` 都重新创建了 `HookEngine`，或是否在业务代码中把 Hook 输出调用了 `addSystemReminder()`。

## 3. pre_tool_use 没有阻止工具

`Agent.executeBatch()` 的顺序是：

```text
Skill toolFilter
  -> HookEngine.firePreToolHooks()
  -> PermissionChecker.check()
  -> StreamingExecutor.submit()
```

Hook 只能拒绝，不能替工具授予权限。命中 `reject` 后，Agent 会生成普通的错误 `ToolResult`：

```text
Rejected by Hook policy: <reason>
```

真正的工具不会提交给 `StreamingExecutor`。排查时不要只看模型有没有请求工具，要看工具实现是否被调用，以及 `tool_result.isError` 是否为 `true`。

## 4. Command Hook 被拒绝

`HookCommandActionExecutor` 不直接调用 `spawn`，它只把 Hook 转成 `HookCommandRequest`。实际执行在 `Agent.executeHookCommand()`：

1. 使用工具名 `HookCommand` 调用 `PermissionChecker.check()`。
2. Ask 时复用 `onPermissionRequest()`。
3. `allowAlways` 复用 `PermissionChecker.allowAlways()`。
4. 通过后才调用 `BashTool.execute()`。

异步 Hook 不能等待弹窗；如果结果是 Ask，会返回拒绝，避免后台任务在用户无感知时执行命令。

## 5. HTTP Hook 存在 SSRF 风险

HTTP Hook 使用 `fetchSafeText()`，不是裸 `fetch()`。它会检查：

- 只允许 HTTP/HTTPS；
- 公网目标必须 HTTPS；
- loopback 只有显式允许时才可访问；
- 每次重定向重新解析和检查 DNS；
- 响应体有大小上限；
- 请求有超时和最大重定向次数。

`HookHttpActionExecutor` 只发送固定的 HookContext JSON，不接受任意 headers 或 shell 模板，因此不能借 Hook 配置把 HTTP 变成隐蔽的 curl 通道。

## 6. shutdown Hook 为什么不弹窗

Ink 卸载时，App 的权限弹窗已经不能可靠显示。`App` 的清理 effect 会派发 `shutdown`，但没有活动 Agent 执行器，因此命令/HTTP 副作用安全失败；不会在退出阶段绕过审批静默执行。

这是明确的安全取舍：退出时允许 prompt 类型做状态通知，但不能为了“执行成功”而放弃权限边界。

## 7. 推荐调试方法

先运行最小静态检查：

```text
pnpm.cmd typecheck
git diff --check
```

章节验收再运行：

```text
pnpm.cmd test
pnpm.cmd build
```

重点断点函数：`loadConfigLayers()`、`validateHooks()`、`HookEngine.fire()`、`HookEngine.firePreToolHooks()`、`Agent.streamResponse()`、`Agent.executeBatch()`、`Agent.executeHookCommand()` 和 `Agent.executeHookHttp()`。
