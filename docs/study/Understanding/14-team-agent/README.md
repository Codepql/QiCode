# 第 14 章开发前理解：Agent Team 是什么？

## 背景：SubAgent 已经能委派任务，为什么还需要 Team？

第 12 章的 SubAgent 很像一次函数调用：主 Agent 把一个边界清楚的任务交出去，等待结果，拿到一份摘要后结束。

```text
主 Agent
  -> “只分析登录模块”
  -> SubAgent 独立执行
  -> 返回一份总结
  -> SubAgent 生命周期结束
```

这个模式适合“做完就交卷”的任务。但它不适合下面的场景：

- 一个成员要长期负责测试；
- 一个成员完成第一轮分析后，需要等待 reviewer 追问；
- 两个成员要直接交流，不想每条消息都经主 Agent 转发；
- Lead 希望一直看到成员在运行、空闲还是失败。

Agent Team 的目标是让成员变成能持续存在的协作者，而不是一次性的临时函数。

## Team 的最小模型

```text
Lead（主 Agent）
  ├─ TeamManager：管理多个 Team
  │    └─ Team "feature-review"
  │         ├─ Lead mailbox
  │         ├─ member: explorer（自己的邮箱、对话、进度）
  │         ├─ member: tester（自己的邮箱、对话、进度）
  │         └─ member: reviewer（自己的邮箱、对话、进度）
  │
  └─ 每轮读取 Lead mailbox，把成员消息作为 reminder 注入模型
```

一个 Team 至少包含四类东西：

1. **成员表**：谁在 Team 中、是否还活跃、怎样取消。
2. **邮箱**：成员间可靠交换消息的共享媒介。
3. **执行循环**：成员完成一轮任务后不立刻消失，而是等待下一条消息或 shutdown。
4. **进度快照**：TUI 用它展示运行状态、最近工具活动和 token 用量。

## 邮箱为什么要写到文件？

内存数组最简单，但成员未来可能在同一进程、子进程或终端复用器窗口中运行。文件邮箱让通信协议不依赖“两个对象恰好在同一块内存”。

邮箱采用追加式 JSONL：一条消息一行 JSON；每个接收者另有一个 cursor 文件记录“我已经读到第几行”。

```text
mailbox.jsonl
  第 1 行：explorer -> lead
  第 2 行：lead -> tester
  第 3 行：reviewer -> explorer

tester.cursor
  记录 tester 已读到第 2 行
```

多个成员同时写文件时会竞争，因此邮箱还需要锁文件。锁不是业务功能，而是为了保证两条 JSON 不会写到同一行、cursor 不会倒退。

## 成员是如何“长期活着”的？

成员不是永远占着模型请求。它的循环是：

```text
收到初始任务
  -> 跑一轮 Agent
  -> 给 Lead 发 idle / completed / failed 通知
  -> 每 500ms 轮询自己的邮箱
  -> 收到新消息：把消息组合成下一轮 prompt，再继续运行
  -> 收到 shutdown：归档对话并退出
```

因此 Team 的“持久”指的是成员身份、对话、邮箱和调度循环持续存在；不是让 LLM 连接永不关闭。

## 为什么 Lead 有 Team 时要被限制写工具？

如果 Lead 既创建 Team，又继续自己写文件，团队会退化成“Lead 自己干活，成员只是旁观”。更严重的是 Lead 和成员可能同时写同一目录。

Coordinator Mode 在至少一个 Team 存在时收紧 Lead 的普通工具集：保留协作工具与只读工具，去掉写文件和高风险执行工具。插件来源工具不强制过滤，避免破坏第三方工具契约。删除最后一个 Team 后，原工具集恢复。

这不是权限系统的替代，而是协作层的角色约束。

## Worktree 与 Team 的关系

第 13 章提供 `EnterWorktree` / `ExitWorktree`。第 14 章不会偷偷让每个成员自动创建 Worktree；成员需要时显式发现并使用 Worktree 工具。

```text
Team：谁负责什么、如何沟通、是否继续活着
Worktree：某个成员具体在哪个目录修改文件
```

它们解决的是不同问题：Team 解决协作拓扑，Worktree 解决文件写入隔离。

## 本章还包含一个“代码评审协作”子系统

普通 Team 是通用基础设施。代码评审子系统在其之上定义 reviewer、lead、junior、critic 四种角色，以及 review request、comment、critic 评估、最终报告的业务语义。

不要反过来理解：不是先写一个只适用于 Code Review 的 Team，而是先完成通用 Team，再让 Code Review 复用邮箱、成员和状态。

## 本章不做什么

- 不做跨机器、分布式 Team。
- 不实现复杂任务依赖图和自动任务拆分。
- 不让成员自动合并 Worktree。
- 不让 Lead 自动审批 Plan。
- 不把所有终端后端都实现完；默认进程内后端，其他模式按明确能力支持或拒绝。

## 读代码时记住这条主线

```text
CreateTeamTool
  -> TeamManager.create()
  -> Team.addMember() / Team.spawnMember()
  -> FileMailbox.send()
  -> 成员执行一轮 Agent
  -> FileMailbox 给 Lead 写通知
  -> App 下一轮 transient reminder 注入 Lead 上下文
```

面试时可以概括为：**SubAgent 是一次委派，Team 是带身份、邮箱和生命周期的协作系统；Worktree 负责成员之间的文件隔离；Coordinator Mode 防止 Lead 绕过团队自己写代码。**
