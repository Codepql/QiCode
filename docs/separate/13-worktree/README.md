# 第 13 章开发分割：Worktree 隔离

> 依据 `docs/plan/13-workTree/`，并按当前项目目录统一使用 `.QiCode/`，不采用旧规划里的 `.qicode/`。
>
> 开发阶段不创建、不运行 `*.test.*`。每阶段只运行 `pnpm.cmd typecheck` 和 `git diff --check`；最后一阶段集中补测试、全量验收和学习文档。

## 目标与边界

本章向模型暴露 `EnterWorktree`、`ExitWorktree` 两个延迟发现工具，为需要独立文件目录的任务创建 Git Worktree。工具只负责创建、读取状态、检测改动和清理；不负责自动合并、自动包装 SubAgent，也不实现 Team。

依赖顺序如下：

```text
安全解析 Git 文件
  -> Worktree 生命周期
     -> 创建后初始化
        -> 两个 Tool
           -> Runtime 注册、延迟发现、后台白名单
              -> 集中测试与真实手测
```

## 阶段 1：Git 元数据安全解析

**目标：** 不启动 Git 子进程，直接从文件系统解析 `.git`、`HEAD`、ref 和 `packed-refs`，得到当前分支与 commit SHA。

**预计文件：**

- 新建 `src/worktree/git-state.ts`

**关键点：**

- 支持普通仓库的 `.git` 目录与 Worktree 中 `.git` 指针文件。
- 支持分支 HEAD 和 detached HEAD。
- ref 先查松散 ref，再查 `packed-refs`，并处理 `commondir`。
- 所有 ref 通过集中校验；出现路径穿越、非法字符或解析异常时返回空值。

**完成标志：** 输入一个目录可以安全得到 Git 目录、HEAD SHA、分支名；没有任何解析结果进入 shell 命令拼接。

## 阶段 2：Worktree 生命周期与改动检测

**目标：** 建立 `createAgentWorktree`、`hasWorktreeChanges`、`removeAgentWorktree` 等底层能力。

**预计文件：**

- 新建 `src/worktree/worktree.ts`
- 可能新增共享常量或类型文件

**关键点：**

- slug 只允许字母、数字、`-`、`_`；目录固定为 `.QiCode/worktrees/<slug>`，分支固定为 `worktree-<slug>`。
- 已存在目录走文件系统快速恢复，不重复执行 `git worktree add`。
- 创建时允许覆盖同名残留分支。
- 改动检测同时检查工作区修改和 HEAD 是否偏离基准 commit；任何检测错误都按“有改动”处理。
- 清理按“删除 Worktree，再删除分支”执行，任一步失败都返回可诊断结果而非中断整个应用。

**完成标志：** 生命周期 API 的输入输出不依赖 TUI，且创建、复用、保留、清理四条路径都有明确结果。

## 阶段 3：创建后初始化

**目标：** 给新 Worktree 提供可运行的非敏感环境，不把初始化失败变成创建失败。

**预计文件：**

- 修改 `src/worktree/worktree.ts`
- 视复杂度新建 `src/worktree/setup.ts`

**关键点：**

- 仅 allowlist 复制 `.QiCode` 中可共享的配置、Agent/Skill 定义；排除 `config.local.yaml`、密钥、会话、记忆等运行时状态。
- 按优先级设置项目 hooks 或默认 hooks 路径。
- 主仓库已有依赖目录时，尝试为 Worktree 创建软链接；失败只给出警告。
- 读取 `.worktreeinclude`，忽略空行、注释、缺失路径和包含 `..` 的路径。

**完成标志：** 每一个初始化子步骤独立容错，创建结果仍会返回，并能携带 warnings。

## 阶段 4：EnterWorktree 与 ExitWorktree 工具

**目标：** 把底层生命周期转换为模型可调用的结构化工具结果。

**预计文件：**

- 新建 `src/tools/enter-worktree.ts`
- 新建 `src/tools/exit-worktree.ts`

**关键点：**

- `EnterWorktree` 只接收 `slug`，校验后返回 Worktree 路径、分支、HEAD。
- `ExitWorktree` 接收 Worktree 路径、分支、仓库根目录和可选基准 commit。
- 有改动时绝不删除，返回保留位置；无改动时清理。
- 两个工具都标记 `deferred: true`，默认不进入模型工具列表。

**完成标志：** 非法 slug、缺参、底层错误和有改动的保留路径都转换成明确的 `ToolResult`。

## 阶段 5：Runtime、工具发现与 SubAgent 接入

**目标：** 注册两个延迟工具，使主 Agent 和后台 SubAgent 都能通过 `ToolSearch` 发现它们。

**预计文件：**

- 修改 `src/tui/runtime.ts`
- 修改 `src/agents/tool-filter.ts`
- 可能修改相关注册测试或类型

**关键点：**

- 初始 schema 不包含 Worktree 工具；`ToolSearch("worktree")` 找到后，必须 `select:EnterWorktree,ExitWorktree` 才能在下一轮调用。
- 后台 SubAgent 的更小工具白名单加入这两个工具；是否调用仍由模型决定。
- 不修改既有读写工具签名。模型拿到 Worktree 路径后，在后续工具调用中显式传递绝对路径。
- `AgentDefinition.isolation` 继续只是预留字段，本阶段不在 Runner 中自动创建 Worktree。

**完成标志：** 工具发现状态只属于当前 Registry；子 Agent 视图不会反向污染父 Registry。

## 阶段 6：集中验收与学习交付

**这是本章唯一创建、运行测试的阶段。**

**预计文件：**

- 新建 `tests/worktree/git-state.test.ts`
- 新建 `tests/worktree/worktree.test.ts`
- 新建 `tests/tools/enter-worktree.test.ts`
- 新建 `tests/tools/exit-worktree.test.ts`
- 修改 `tests/agents/tool-filter.test.ts`、`tests/tui/runtime.test.ts`（若现有结构需要）

**验收覆盖：**

- 普通仓库、Worktree、branch HEAD、detached HEAD、松散 ref、packed ref 与非法 ref。
- slug 路径穿越、同名 Worktree 快速恢复、残留分支覆盖。
- 工作区变更、HEAD 前进和检测异常时的保留策略。
- 初始化的 allowlist、敏感文件排除、include 路径过滤及软链接失败降级。
- 延迟发现、select 后下一轮可用，以及后台子 Agent 白名单。
- 真实手测：创建一个 Worktree，在其中写入探针文件，确认主目录未变化；退出时验证“有改动保留”和“无改动清理”。

**最终命令：**

```powershell
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd build
git diff --check
```

通过后才更新或创建：

- `docs/study/Debug/13-worktree/README.md`
- `docs/study-Interview/13-worktree/README.md`

## 为什么这样拆分？

阶段 1 是最高风险的安全边界：如果 HEAD/ref 解析不可靠，后面的状态判断和清理都会错。阶段 2 只依赖安全的 Git 状态读法，先把生命周期做成独立能力。阶段 3 在生命周期稳定后再加入便利初始化，避免把复制、链接问题混进 Git 创建问题。阶段 4 才向模型暴露工具，阶段 5 最后接入按需发现和子 Agent。这样每一阶段只有一个主要变量，定位失败不会横跨整个 TUI 和 Git 生命周期。
