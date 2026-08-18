# 第 14 章面试：Agent Team

## 30 秒介绍

我把一次性的 SubAgent 扩展成可持续协作的 Agent Team。每个成员有独立身份、文件 mailbox、进度快照和取消能力；完成一轮任务后进入 idle，等待新消息。Lead 在下一轮请求前消费 mailbox，把结果作为 transient reminder 注入，而不写回主 Conversation。

## 常见问题

### Team 和 SubAgent 的区别？

SubAgent 是一次性委派：输入任务，返回结果，生命周期结束。Team 成员是长期协作者：完成任务后可继续接收 Lead 或成员消息，并有可观察、可取消的生命周期。

### 为什么 mailbox 用 JSONL？

内存队列只能服务同一进程。JSONL 采用追加写；每个接收者有独立 cursor，可在重启后避免重复消费。文件锁保护并发写入和 cursor 更新。

### 为什么用 transient reminder？

成员消息是运行时事件，不应该永久伪装成用户或助手对话。transient reminder 只影响下一轮决策，读完即消费，既让 Lead 看见结果，又不污染主 Conversation。

### Coordinator Mode 是权限系统吗？

不是。权限系统决定工具调用是否执行；Coordinator Mode 是协作约束。存在 Team 时它收窄 Lead 的普通工具可见性，让 Lead 偏向分派、沟通和汇总，减少与成员并发抢写代码。

### 为什么 `RunAgent` 用依赖注入？

`Team` 不知道 Provider 或 LLM 协议，只依赖“执行任务并返回结果”的接口。App 将现有 `SubAgentRunner` 包成闭包注入，因此 Team 易测试，也可替换后端。

### Code Review 为什么不直接管理成员进程？

Code Review 只增加 reviewer、critic、评论和报告语义；成员生命周期、邮箱、状态快照仍交给 TeamManager。这避免为单一场景复制调度和通信机制。

## 设计取舍

| 取舍 | 选择 | 原因 |
| --- | --- | --- |
| 通信 | 文件 JSONL + cursor | 支持独立进程，重启后可继续消费 |
| 结果交付 | transient reminder | 不污染主 Conversation |
| UI 状态 | Team 维护，TUI 读快照 | 避免双份状态不一致 |
| 默认后端 | in-process | 最低复杂度，tmux 显式选择 |
| 协作约束 | 工具过滤 | 不改变既有 PermissionChecker 语义 |

## 如何证明可靠

本章新增 mailbox、Team、progress、Code Review 测试。最终结果为 49 个测试文件、254 个测试通过，同时通过类型检查、生产构建和 diff 检查。

一个真实回归是：`/code-review` 初始误用了已有 `/review` 别名，命令注册抛错使 Ink 空白。修复为 `/cr` 并保留原 `/review`。这说明组合根的命名冲突属于重要集成风险，不能只依赖模块单测。

## 练习题

如果要让两个成员在不同 worktree 修改同一仓库，worktree 分配应放在哪里？

答案方向：不要塞进 FileMailbox 或 TUI；应放在成员启动策略中，先调用 Worktree 层、记录成员工作目录，再将目录注入 RunAgent。合并、冲突和清理策略需要单独设计。
