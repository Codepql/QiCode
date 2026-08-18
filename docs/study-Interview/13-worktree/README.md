# 第 13 章 Interview：Worktree 隔离

## 一句话项目回答

第 12 章的 SubAgent 已经隔离了对话、权限和取消状态，但仍共享文件系统；第 13 章用 Git Worktree 给需要独立修改的任务提供单独目录和分支，并通过按需发现的 `EnterWorktree` / `ExitWorktree` 管理创建、改动检测和保守清理。

## 高频问题 1：为什么 Git branch 不够？

**回答：** branch 隔离的是版本指针，不是当前工作目录。一个目录同一时刻只能 checkout 一个分支；两个 Agent 如果同时写同一个目录，仍然会互相覆盖。Worktree 让同一个仓库同时挂载多个目录，每个目录各自 checkout 一个分支，所以解决的是空间维度的并发冲突。

**追问：** Worktree 是否复制了整个仓库？

**回答：** 不完全是。它共享 Git 对象库和历史，但拥有独立的工作目录和 checkout 状态。大型仓库不需要为每个任务复制全部 `.git` 对象。

## 高频问题 2：为什么不让 SubAgent 自动创建 Worktree？

**回答：** `AgentDefinition.isolation: "worktree"` 在本章只保留为定义字段，不由 `SubAgentRunner` 自动消费。创建 Worktree 会产生目录、分支、初始化和清理成本，且任务是否需要写隔离目录需要模型结合上下文判断。把它做成显式工具调用，能留下清晰的审计点，也避免所有任务无差别创建 Worktree。

**追问：** 这是不是意味着 isolation 字段没用？

**回答：** 它是后续自动编排能力的契约预留。本章刻意不把“声明字段”与“有副作用的目录创建”绑定，避免提前引入错误的生命周期语义。

## 高频问题 3：为什么 Worktree 工具必须 deferred？

**回答：** Worktree 的 schema 包含路径、分支、基准 commit 和清理参数，不是每轮任务都需要。`ToolRegistry` 先把它们注册为 deferred，模型只有先用 `ToolSearch("worktree")` 搜索，再用 `select:` 激活，下一轮才能看到完整 schema。这样减少初始上下文和 prompt cache 波动。

**追问：** 搜索命中后为什么不能立即调用？

**回答：** 搜索结果只是候选工具描述，`markDiscovered()` 才会改变 Registry 的可见状态。下一轮重新生成 schema，模型才会在正式工具列表中看到完整参数，避免在同一请求里混淆“发现”和“执行”。

## 高频问题 4：为什么 `EnterWorktree` 只接受 slug？

**回答：** 目录和分支由系统统一推导：`.QiCode/worktrees/<slug>` 与 `worktree-<slug>`。如果让模型直接传完整路径或分支名，就会扩大路径穿越、分支删除和命令注入的攻击面。slug 只允许字母、数字、连字符和下划线，系统再拼出固定结构。

**追问：** 为什么 `ExitWorktree` 又需要 path 和 branch？

**回答：** Exit 发生在后续轮次，工具不能依赖内存中的创建对象；它需要模型显式带回 Enter 的结果。底层仍会验证 path 位于受管目录且 branch 恰好匹配 `worktree-<slug>`，所以显式参数不等于信任参数。

## 高频问题 5：为什么 `hasWorktreeChanges` 检查两个维度？

**回答：** `git status --porcelain` 只能看到未提交的文件变化，不能发现 Worktree 已经产生了新的 commit。因此还要比较当前 HEAD 和创建时的 baseline commit。两个检查都没有变化，才可以认为安全清理。

**追问：** 读取 Git 状态失败怎么办？

**回答：** 返回“有改动”。这是 fail-closed 策略：检测失败时保留目录，避免因为 `.git` 损坏、权限问题或外部清理导致误删用户成果。

## 高频问题 6：为什么清理分成两个 Git 操作？

**回答：** Worktree 目录和分支是两个资源。先执行 `git worktree remove --force <path>`，再执行 `git branch -D <branch>`，每一步单独捕获错误。这样即使目录已经被外部删除，分支仍有机会被清理；反过来也不会因为第一步异常而吞掉第二步结果。

**追问：** 为什么允许 `--force`？

**回答：** Exit 已经先做了改动检测；`--force` 只是处理 Git 对工作目录的强制移除，不代表跳过本项目的保护逻辑。检测失败或发现改动时，Exit 根本不会进入清理路径。

## 高频问题 7：为什么初始化失败不回滚创建？

**回答：** Git Worktree 创建和便利初始化是两个层次。复制 Agent/Skill、设置 hooks、链接依赖、复制 include 文件都可能因权限、平台或文件缺失失败，但这不意味着已经创建的隔离目录不可用。每个子步骤独立捕获 warning，保留可诊断结果，避免失败清理造成二次损失。

## 高频问题 8：为什么不复制整个 `.QiCode`？

**回答：** `.QiCode` 同时包含定义和运行时状态。当前只复制 `agents/`、`skills/`；Provider 配置、MCP 配置、权限本地文件、sessions、memory 等都可能包含凭据或用户私有状态，不能随着 Worktree 传播。这是 allowlist，而不是复制后再猜哪些文件敏感。

## 高频问题 9：为什么 Git ref 解析不直接执行 `git rev-parse`？

**回答：** 第 1 阶段对 `.git`、`HEAD`、ref 和 `packed-refs` 做纯文件解析，避免每次读取状态都启动子进程，也把 ref 校验集中在一个边界。创建和清理这类确实需要 Git 改写的动作才使用 `execFile` 参数数组。

**追问：** 直接解析 Git 文件可靠吗？

**回答：** 它只覆盖本章需要的 HEAD、分支和 packed ref 场景；解析异常返回空状态，不假装支持所有 Git 内部格式。复杂合并、reftable 等扩展仍可在后续补充或回退到 Git 命令。

## 高频问题 10：后台 SubAgent 为什么也能使用 Worktree？

**回答：** 后台任务仍然可能执行长时间、多文件修改，和主目录并发写入的风险更高。因此后台白名单加入 `EnterWorktree` 和 `ExitWorktree`。它们是 deferred 工具，后台 Agent 仍需显式搜索，不会因为白名单存在就自动创建目录。

## 面试时应主动说明的边界

- 本章不实现自动 merge、cherry-pick 或代码同步。
- 本章不让 Runner 根据 isolation 自动创建 Worktree。
- Worktree 不隔离网络、环境变量或 API 凭据；它主要隔离文件目录和分支。
- Windows 软链接可能失败，初始化会返回 warning 并继续。
- 有改动的 Worktree 由上层决定如何合并，工具不会擅自丢弃成果。

## 面试官继续追问时的完整链路

```text
ToolSearch
  -> ToolRegistry.markDiscovered
  -> EnterWorktreeTool.execute
  -> createAgentWorktree
  -> runGit(["worktree", "add", "-B", branch, path])
  -> performPostCreationSetup
  -> 后续 ReadFile / WriteFile 使用返回的绝对路径
  -> ExitWorktreeTool.execute
  -> hasWorktreeChanges
  -> removeAgentWorktree 或保留并返回路径
```

这条链路体现了本项目的三个工程取舍：**副作用通过显式工具触发，输入在边界验证，删除在不确定时保守。**
