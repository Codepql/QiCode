# 第 12 章 Interview：SubAgent

## 1. SubAgent 和线程、进程有什么区别？

本章的 SubAgent 是同一 Node.js 进程中新建的一套 Agent 运行对象，不是线程，也不是操作系统进程。它不会天然隔离内存或文件系统。

真正隔离的是应用状态：每次 `SubAgentRunner.run()` 新建 Conversation、PermissionChecker、AbortController、用量汇总和工具 Registry 视图。工作目录仍共享，所以文件系统并发隔离留给第 13 章 Worktree。

## 2. 为什么不能把主 Conversation 传给子 Agent？

子 Agent 的探索草稿、失败工具调用和临时假设不应该成为主 Agent 的长期事实。主 Agent 只需要子任务的最终摘要。

因此 Runner 将 prompt 放进新的 Conversation，收集 `stream_text` 形成 `finalText`，不把 thinking、工具参数或完整子历史返回。这样既节省上下文，也降低错误草稿污染主对话的概率。

## 3. 如何禁止递归派生？

不能只在 system prompt 写“不要再调用 Agent”，因为提示词不是权限边界。`createSubAgentToolRegistry()` 从子视图中硬移除名称为 `Agent` 的工具；即使主 Registry 有这个工具，子 Agent 也拿不到 schema，更不可能调用。

这把最大深度固定为 1，控制 token、并发和取消树的复杂度。

## 4. 工具过滤为什么要返回新 Registry？

直接修改父 Registry 会影响正在运行的主 Agent，甚至影响其他子任务。新 Registry 是一个受限视图：它可以复用无状态工具实现，但不会改变父 Registry 的工具列表或 deferred discovery。

特别是 `ToolSearchTool` 有内部 Registry 引用，必须针对子视图重新创建，否则子 Agent 发现工具会反向改主 Agent 状态。

## 5. Provider 模型覆盖如何保证不泄露凭据？

Runner 不接受完整 Provider 配置覆盖，只接受 `modelOverride`。它以父 ProviderConfig 为基底，仅替换 model：

```ts
{ ...parentProviderConfig, model }
```

所以 API Key、base URL、protocol、thinking 继续继承。角色 Markdown 中出现 `api_key` 或 `base_url` 会被 loader 拒绝。错误返回还会用 `safeError()` 脱敏 API Key。

## 6. TaskManager 为什么需要状态机？

后台任务不是一个简单 Promise。它需要被查询、取消、限制并发、通知主 Agent，并在程序退出时清理。

有限状态机是：

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
```

终态不能再跳回 running。每个任务持有自己的 AbortController；cancel 会先 abort，再等待底层 Runner 收尾，最后才释放并发槽位。

## 7. 为什么通知必须去重？

主 Agent 每轮都会发请求，如果每轮都把已完成任务重新插入上下文，模型会反复处理同一结果。`TaskManager.drainNotifications()` 用 `notified` 标记保证一个终态任务只返回一次。

已经通知的终态任务可以在创建新任务前被回收；未通知任务绝不回收，否则主 Agent 会丢结果。

## 8. 后台结果为什么是 transient reminder？

后台子任务结果是运行时事件，不是用户对话历史。App 将通知提供给 `AgentConfig.transientReminders`，Agent 在下一次 Provider 请求临时附加，而不写入 Conversation 或 session JSONL。

子 Agent 输出同样可能不可信，所以 reminder 会标记为 untrusted task output。模型可参考结果，但权限和工具调用仍由代码执行的 PermissionChecker 决定。

## 9. AgentTool 为什么只有一个？

如果每种角色都注册一个工具，schema 会不断膨胀，权限和状态入口也会分散。单一 `AgentTool` 用 `subagent_type` 选择角色，用 `operation` 区分 run/status/cancel；Runner 和 TaskManager 成为唯一执行内核。

这让下一章 Worktree、第 14 章 Team 都能复用底层能力，而无需复制多套“启动子 Agent”的逻辑。

## 10. 本章怎么证明完成？

最终验收为 43 个测试文件、237 条测试：

- 内置、用户、项目角色覆盖和非法 frontmatter；
- 父/子 Registry 隔离与禁止递归；
- 子 Provider 仅覆盖 model；
- TaskManager 并发、取消、一次通知、终态回收；
- AgentTool 的同步运行、后台创建、查询、取消和容量错误；
- 后台通知只进入一次临时模型请求，不污染 Conversation；
- 全量测试、typecheck、build 通过。

面试时可以这样总结：我把 SubAgent 拆为四层，角色定义决定策略，工具过滤建立能力边界，Runner 建立一次性的隔离运行时，TaskManager 管理后台状态；模型工具只是薄入口。这样角色、文件隔离、团队协作可以在后续章节扩展，而不会把权限、对话和任务状态搅在一起。
