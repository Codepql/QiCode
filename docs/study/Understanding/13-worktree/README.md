# 第 13 章开发前理解：为什么 Agent 需要 Worktree？

## 背景：第 12 章已经隔离了什么，还缺什么？

第 12 章的 SubAgent 有自己的对话、权限检查器、取消信号和工具视图。也就是说，两个 Agent 不会混用聊天记录，也不能互相继承“刚才已经允许”的权限决定。

但它们仍然使用同一个工作目录。例如主 Agent 正在修改 `src/app.ts`，后台 SubAgent 也恰好修改同一个文件：两边都可能读到对方写到一半的内容，最后一次保存还可能覆盖前一次保存。这不是模型是否聪明的问题，而是两个任务共享同一份文件系统的并发冲突。

Git branch 也不能解决这个问题。切换分支时，一个目录只能显示一个分支；它是“轮流使用目录”，不是“同时拥有多个目录”。

Git Worktree 允许一个仓库同时拥有多个工作目录：它们共享 Git 对象库，但每个目录各自检出一个分支。因此，主工作目录和一个任务目录可以同时存在、同时编辑而不互相覆盖。

```text
主工作目录 E:\agent-code\QiCode
  branch: main
  -> 主 Agent 在这里工作

.QiCode\worktrees\review-login
  branch: worktree-review-login
  -> 一个隔离任务在这里工作
```

## 本章目标

本章不是让 SubAgent 自动进入 Worktree，也不是实现多 Agent 团队。它只提供两个按需发现的工具：

```text
ToolSearch("worktree")
  -> select: EnterWorktree / ExitWorktree

EnterWorktree(slug)
  -> 创建或复用 .QiCode/worktrees/<slug>
  -> 返回目录、分支、HEAD commit

后续 ReadFile / WriteFile / Bash
  -> 调用时显式传入这个 Worktree 的绝对路径

ExitWorktree(...)
  -> 没有改动：清理目录和分支
  -> 有改动：保留目录和分支，交给上层决定如何合并
```

模型必须先搜索并选择工具，不能默认在每轮工具清单里看见 Worktree。这能保持普通任务的上下文和 prompt cache 稳定，也避免模型无意义地创建大量隔离目录。

## 这里的“隔离”到底是什么？

Worktree 隔离的是 Git 工作目录和分支，不隔离进程、网络、环境变量或模型账户。它也不自动合并代码。创建后得到的目录只是一个独立的改动地点；是否检查、提交、合并或丢弃，仍是上层 Agent 或用户的决定。

第 12 章 `AgentDefinition.isolation: "worktree"` 会继续被保留，但本章不让 `SubAgentRunner` 自动消费它。原因是“是否创建隔离目录”是一个有成本、有清理后果的动作，应该由模型显式调用 `EnterWorktree` 决定，而不是看到字段就偷偷创建。

## 为什么不总是直接执行 Git 命令？

创建和清理 Worktree 的确需要 Git 子进程。但读取一个已经存在的 Worktree 的分支和 HEAD，不应该每次都启动 Git。Git 的这些状态本来就在 `.git`、`HEAD`、`refs`、`packed-refs` 文件中。

本章会实现一层只读解析：

```text
worktree/.git 文件
  -> gitdir: ...
  -> HEAD
     -> ref: refs/heads/worktree-review-login
        -> ref 文件或 packed-refs
           -> commit SHA
```

这里不能把 `HEAD` 或 `packed-refs` 里的任意字符串直接拼到路径或命令中。它们都是外部文件数据，必须先验证 ref 的结构和字符集。解析失败时返回空值；判断改动时宁可保留 Worktree，也不能误删。

## 创建后为什么还要初始化？

新 Worktree 不会天然带上所有未追踪的运行时资料。本章会以 best-effort 方式做四类准备：复制允许共享的 `.QiCode` 配置、设置 Git hooks、复用 `node_modules`、按 `.worktreeinclude` 复制运行必需但被 Git 忽略的文件。

best-effort 的意思是：某一项失败只记录警告，不能让已经创建成功的 Worktree 变成失败。敏感配置和运行时状态，例如 `config.local.yaml`、API Key、会话和记忆，绝不能复制。

## 读代码时先抓住这条主线

```text
EnterWorktreeTool.execute()
  -> 校验 slug
  -> createAgentWorktree()
     -> 已存在：从文件系统快速恢复状态
     -> 不存在：git worktree add + 创建后初始化
  -> 返回路径 / 分支 / HEAD

ExitWorktreeTool.execute()
  -> hasWorktreeChanges()
  -> 有改动：保留
  -> 无改动：removeAgentWorktree()
```

先理解“为什么要给并行任务一份单独目录”，再看 Git 文件解析和初始化细节。面试时可以把本章概括为：**用 Git Worktree 解决并发 Agent 的文件写入冲突；用按需工具发现控制成本；用 fail-closed 的改动检测避免误删用户成果。**

## 本章不做什么

- 不自动合并 Worktree 的代码。
- 不实现 Agent Team、成员通信或任务编排。
- 不让 SubAgent 启动时自动创建 Worktree。
- 不增加 Worktree 的 TUI slash 命令。
- 不承诺 Windows 上所有软链接操作都成功；失败时应降级并给出诊断。
