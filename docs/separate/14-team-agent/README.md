# 第 14 章开发分割：Agent Team

> 基于 `docs/plan/14-teamAgent/`。本章遵循既定节奏：阶段 1–9 不创建、不运行 `*.test.*`，每阶段只执行 `pnpm.cmd typecheck` 和 `git diff --check`；阶段 10 集中补测试、全量验收、真实手测和学习文档。

## 目标与边界

本章让主 Agent 可以创建多个具名 Team、派遣长期存活的成员、通过邮箱接收成员通知，并在 TUI 中观察和控制成员。Team 是进程内协作基础设施；代码评审是建立在 Team 之上的独立业务子系统。

不做跨机器分布式协作、自动 Worktree 包装、复杂依赖图或自动合并。

```text
文件锁
  -> FileMailbox
     -> 进度状态
        -> Team / TeamManager
           -> 后端工厂与成员循环
              -> 5 个协作工具 + Lead reminder + Coordinator Mode
                 -> teammate CLI / TUI 可视化
                    -> Code Review 子系统
                       -> 集中验收
```

## 阶段 1：文件锁与 FileMailbox

**目标：** 建立成员通信的可靠底座。

**预计文件：**

- 新建 `src/teams/file-mailbox.ts`

**实现内容：**

- JSONL 追加消息：`sender`、`text`、ISO 时间。
- cursor 文件记录已读行数；支持同步/异步接收、未读计数、全部标记已读、轮询生成器。
- lock 文件独占创建，最多重试 10 次、5–100ms 抖动、10 秒陈旧锁抢占、`try/finally` 释放。
- 损坏行跳过，cursor 文件缺失或错误时从 0 开始。

**完成标志：** 两个邮箱实例能并发发送和接收，消息不重复消费、不因一条坏 JSON 使整批失败。

## 阶段 2：成员进度与活动描述

**目标：** 给 Team 和 TUI 一份不依赖 UI 的成员运行快照。

**预计文件：**

- 新建 `src/teams/progress.ts`

**实现内容：**

- 成员状态机：运行中、空闲、完成、失败、停止。
- 记录工具调用次数、最近 5 条活动、输入/输出 token、最近消息和 spinner 文案。
- 将 ReadFile、WriteFile、Bash、Glob、Grep 等工具调用转成可读活动描述。

**完成标志：** 进度对象可以只靠 Agent 事件更新；TUI 不参与状态计算。

## 阶段 3：Team、TeamManager 与 Lead 邮箱

**目标：** 定义 Team 的持久身份和多 Team 管理，不启动真实成员。

**预计文件：**

- 新建 `src/teams/team.ts`

**实现内容：**

- `TeamMode`、`Member`、`Team`、`TeamManager`。
- Team 创建自己的目录、Lead 邮箱和成员邮箱。
- 成员添加、查询、停止单个/全部、删除 Team。
- `TeamManager.drainLeadReminders()` 汇总所有 Team 的 Lead 未读消息。

**完成标志：** 同一进程可存在多个 Team；删除 Team 会先取消成员，再从管理器移除。

## 阶段 4：成员后端与执行循环

**目标：** 统一“如何启动一个成员”，先实现安全的进程内路径。

**预计文件：**

- 新建 `src/teams/backend.ts`
- 修改 `src/teams/team.ts`
- 可能修改 `src/agents/runner.ts` 以复用启动入口

**实现内容：**

- 默认后端固定选择进程内，不做隐式环境探测。
- 显式探测函数才检查 tmux / 终端复用器环境；不支持的后端明确拒绝。
- `Team.spawnMember()`：初始任务 → 跑一轮 → 通知 Lead → 每 500ms 轮询邮箱 → 收到新任务继续 → shutdown 时退出。
- Agent 事件写入进度；异常写 failed 通知；退出时归档对话。

**完成标志：** 成员可以在后台等待新任务，而不是完成一次就被销毁。

## 阶段 5：协作工具与 Lead 约束

**目标：** 让模型能操作 Team，并防止 Team 存在时 Lead 直接抢写代码。

**预计文件：**

- 新建 `src/teams/tools.ts`
- 新建 `src/teams/coordinator.ts`
- 修改 `src/agent/agent.ts`
- 修改 `src/tui/app.tsx` 或 Runtime 组合点

**五个工具：**

```text
CreateTeam   创建或复用 Team
SpawnMember  创建 Team（如需要）并后台派遣成员
SendMessage  向成员或 Lead 邮箱写消息
ListTeams    查询 Team 与成员快照
DeleteTeam   取消成员并删除 Team
```

**关键点：**

- 每轮请求前 drain Lead 邮箱，作为 transient reminder 注入主 Agent，不写回 Conversation。
- 至少有一个 Team 时，Coordinator Mode 过滤 Lead 的写类工具；所有 Team 删除后恢复。
- 既有 `AgentTool` / SubAgent 路径不加入 team 参数分支，保持原语义。

**完成标志：** Lead 能创建、派遣、发消息、查询和删除 Team；成员通知会在下一轮被 Lead 看见。

## 阶段 6：成员独立 CLI 入口与归档

**目标：** 为子进程或终端复用器成员提供无 TUI 的启动入口。

**预计文件：**

- 新建 `src/teammate.ts`
- 修改 `src/main.tsx`
- 新建或补充 `src/teams/transcript.ts`

**实现内容：**

- 解析 `--teammate` 参数后走成员循环，不渲染主 TUI。
- 构造独立 Conversation / PermissionChecker / Agent 上下文。
- 结束时将可用对话和工具记录归档到 Team 目录。

**完成标志：** 主进程与成员进程入口清晰分离，成员模式不会意外启动 Ink UI。

## 阶段 7：TUI 成员可视化与控制

**目标：** 让用户看到成员正在做什么，并能查看或停止成员。

**预计文件：**

- 新建 `src/tui/team-status.tsx`
- 新建 `src/tui/teammate-message.tsx`
- 新建 `src/tui/teammate-spinner-line.tsx`
- 新建 `src/tui/teammate-spinner-tree.tsx`
- 新建 `src/tui/teams-dialog.tsx`
- 修改 `src/tui/app.tsx`

**实现内容：**

- 状态栏显示活跃成员数。
- Spinner Tree 展示成员状态、最近工具活动、token。
- 成员消息按发件人显示；idle / shutdown 静默，completed 给完成标记。
- Teams Dialog 支持列表、详情、停止成员和请求 shutdown。

**完成标志：** TUI 只是读取 TeamManager 快照，不保存另一份成员真相。

## 阶段 8：代码评审协作子系统

**目标：** 在通用 Team 之上实现可持久化的 Code Review 工作流。

**预计文件：**

- 新建 `src/code-review/manager.ts`
- 新建 `src/code-review/session.ts`
- 新建 `src/code-review/handler.ts`
- 修改命令注册入口

**实现内容：**

- reviewer / lead / junior / critic 角色与激活状态。
- 评审请求、评论增删改、critic 评价、最终报告。
- 所有角色操作同步到底层 Team；不重新发明邮箱和成员状态。
- 增加 `/review` 子命令族。

**完成标志：** Code Review 层只编排业务语义，不越过 TeamManager 直接管理成员进程。

## 阶段 9：示例与手动场景准备

**目标：** 提供独立阅读入口和最终真实手测脚本，不提前跑测试。

**预计文件：**

- 新建 `examples/create-custom-team.ts`
- 新建 `examples/create-code-review-team.ts`

**手测场景：**

- 创建 Team，派遣两个只读成员，验证 Lead 下一轮收到 idle/结果通知。
- 成员 A 给成员 B 发消息，验证 B 下一次轮询接收。
- Team 存在时 Lead 的写工具被 Coordinator Mode 过滤；删除最后一个 Team 后恢复。
- 打开 Teams Dialog，观察状态与停止成员。

## 阶段 10：集中验收与学习交付

**这是本章唯一创建、运行测试的阶段。**

**预计测试：**

- `tests/teams/file-mailbox.test.ts`
- `tests/teams/team.test.ts`
- `tests/teams/progress.test.ts`
- `tests/teams/tools.test.ts`
- `tests/teams/coordinator.test.ts`
- `tests/code-review/*.test.ts`
- 需要时补 Agent / TUI 集成测试。

**验收覆盖：**

- 并发写、cursor、锁重试、陈旧锁、损坏 JSONL。
- 多 Team、成员生命周期、消息路由、shutdown、失败通知和归档。
- 默认后端选择、明确探测、拒绝不支持终端后端。
- Lead reminder 一次性注入、Coordinator Mode 开关、插件工具不受误伤。
- TUI 树、Dialog 键盘操作、取消恢复。
- Code Review 的角色、评论、critic 和报告。

**最终命令：**

```powershell
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd build
git diff --check
```

通过后才生成：

- `docs/study/Debug/14-team-agent/README.md`
- `docs/study-Interview/14-team-agent/README.md`

## 为什么这样拆分？

邮箱和锁必须最先完成，因为成员循环、跨成员通信和跨进程后端全都依赖它。进度状态独立于 TUI，避免“界面组件既算状态又渲染状态”。Team 核心在不启动 Agent 时先稳定成员身份和 Lead mailbox；随后才接执行循环和工具。TUI 与 Code Review 分别建立在稳定的 Team API 之上，避免把视觉状态或评审业务规则塞回并发调度层。
