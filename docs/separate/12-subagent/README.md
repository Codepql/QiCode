# 第 12 章开发分割：通用 SubAgent

> 基于 `docs/plan/12-subAgent/`，并按当前代码事实调整。本章完成一次性 SubAgent 和后台任务，不提前实现 Worktree、Team 或递归派生。

## 开发前基线修正

| 原规划表述 | 本章实施采用的事实 |
| --- | --- |
| `~/.qicode/agents`、`.qicode/agents` | 当前项目运行目录统一为 `~/.QiCode/agents/`、`<workDir>/.QiCode/agents/`。 |
| 可直接复用旧 fork 代码 | `src/skills/fork-runner.ts` 仅服务 fork Skill；通用 SubAgent 建立 `src/agents/`，避免 Skill 概念倒灌。 |
| 测试先行、阶段内不断运行 | 按当前学习节奏：阶段 1–6 不创建、不运行 `*.test.*`；只运行 `pnpm.cmd typecheck` 和 `git diff --check`。阶段 7 集中补测试和全量验收。 |
| Hook 与子 Agent 的关系未明确 | 子 Agent 使用自己的 `Conversation`、权限与取消信号；是否复用 HookEngine 必须在 Runner 注入点明确，不能让 Hook 状态意外跨子任务泄漏。 |

## 目标与边界

```text
主 Agent
  -> AgentTool（模型看到的单一工具）
       -> AgentDefinitionCatalog（选择角色）
       -> ToolFilter（构造工具视图）
       -> SubAgentRunner（独立运行）
            -> Conversation / PermissionChecker / AbortController
            -> Agent.run()
       -> TaskManager（仅后台任务）
```

- 子 Agent 可共享无状态工具实现和工作目录，但绝不共享主对话、权限会话白名单、token 统计或 AbortController。
- 子 Agent 永远没有 `Agent` 工具，深度固定为 1。
- `model` 可以覆盖；`protocol`、`base_url`、`api_key`、`thinking` 只能继承父 Provider 配置。
- 后台任务必须受并发、时长、轮次、输出长度限制，退出时统一取消。

## 阶段 1：角色契约与内置角色

**目标：** 定义后续所有模块共享的 `AgentDefinition`，加入 `general-purpose`、`plan`、`explore` 三个内置角色。

**预计文件：**

- 新建 `src/agents/definition.ts`

**关键决策：**

- 字段包含名称、描述、工具 allow/deny、系统提示覆盖、最大轮次、模型、权限模式、后台标记、`isolation` 占位、初始提示、Skill/MCP 选择。
- `name` 必须是安全 slug；数值字段必须有范围和默认上限。
- `isolation: "worktree"` 只保留数据，不在本章消费。

**完成标志：** 类型不依赖 TUI 或 Provider 具体实现；三个内置角色可由纯函数取得。

## 阶段 2：角色定义加载与诊断

**目标：** 从内置、用户、项目三个层级读取 Markdown frontmatter，并让后层覆盖同名角色。

**预计文件：**

- 新建 `src/agents/loader.ts`
- 可能小改 `src/agents/definition.ts`

**关键决策：**

- 路径使用 `.QiCode/agents/`。
- frontmatter 采用字段白名单；不认识的字段、非法 slug、越界数值都形成诊断。
- 单文件错误只跳过该文件，不能阻止其他角色加载。
- 定义文件不能出现或覆盖 Provider 凭据。

**完成标志：** 调用方可同时拿到有效定义和诊断列表。

## 阶段 3：工具视图过滤

**目标：** 给子 Agent 创建受限 `ToolRegistry`，而不是修改主 Registry。

**预计文件：**

- 新建 `src/agents/tool-filter.ts`

**过滤顺序：**

```text
先移除 Agent（禁止递归）
  -> 保留必要系统安全工具
  -> 后台默认更小的工具集
  -> definition.tools allowlist
  -> definition.disallowedTools denylist
  -> Skill / MCP 选择
  -> 真正执行前仍由 PermissionChecker 检查
```

**完成标志：** 父 Registry 的内容和 discovered 状态不变；返回的新视图中永远没有 `Agent`。

## 阶段 4：同步 SubAgentRunner

**目标：** 用角色定义启动一次独立 Agent，收集最终文本和用量摘要。

**预计文件：**

- 新建 `src/agents/runner.ts`

**关键决策：**

- 每次运行新建 `Conversation`、`PermissionChecker`、AbortController 和计数对象。
- Provider 只从父 `ProviderConfig` 派生，模型覆盖只能替换 `model`。
- 进度通过回调上报，不能写回父 Conversation。
- 超时、外部取消、最大轮次、输出长度必须返回结构化停止结果。

**完成标志：** 同步调用只得到 finalText、安全摘要、stopReason 和 usage，不暴露子 Agent thinking 或完整历史。

## 阶段 5：TaskManager 后台状态机

**目标：** 将 Runner 包装成可查询、可取消、有限并发的后台任务。

**预计文件：**

- 新建 `src/agents/task-manager.ts`

**状态机：**

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
```

**关键决策：**

- 每个 taskId 只有一个 AbortController，状态不能非法跳转。
- 设置并发槽位和排队/拒绝策略；结果只保存有上限的摘要。
- 完成通知带 `taskId` 和状态，通过 notified 标记确保只消费一次。
- `cancelAll()` 用于应用退出，等待时间有限。

**完成标志：** 后台任务不会阻塞 TUI；查询、取消、完成通知均可观察。

## 阶段 6：单一 AgentTool 与 App 接入

**目标：** 模型通过一个 `Agent` 工具选择角色，使用同步或后台路径；TUI 显示进度和后台完成通知。

**预计文件：**

- 新建 `src/agents/agent-tool.ts`
- 修改 `src/tui/runtime.ts`
- 修改 `src/tui/app.tsx`
- 视实际需要修改 `src/main.tsx`

**关键决策：**

- schema 只有 `description`、`prompt`、`subagent_type`、`model` 等本章字段，不加入 Team 字段。
- 未知角色、非法模型、超过资源上限都变成清晰的 ToolResult。
- 主 Agent 在每轮请求前只消费一次后台完成通知；TUI 退出时调用 `cancelAll()`。

**完成标志：** 同步结果作为 ToolResult 回灌主 Agent；后台路径立即返回 taskId，完成后不会重复通知。

## 阶段 7：集中验收与学习交付

**此阶段才创建并运行测试。**

**预计测试：**

- `tests/agents/definition.test.ts`
- `tests/agents/loader.test.ts`
- `tests/agents/tool-filter.test.ts`
- `tests/agents/runner.test.ts`
- `tests/agents/task-manager.test.ts`
- `tests/agents/agent-tool.test.ts`
- 必要时修改 Agent/TUI 集成测试。

**验收覆盖：**

- 角色覆盖、坏文件诊断、slug 和字段边界；
- 禁止递归、父 Registry 不变、后台工具集合更小；
- 父子 Conversation/权限/usage 隔离；
- 同步任务、模型覆盖限制、取消、超时、轮次和输出上限；
- 状态机、并发、一次通知、查询、取消和退出清理；
- `pnpm.cmd test`、`pnpm.cmd typecheck`、`pnpm.cmd build`、`git diff --check`。

验收通过后再生成：

- `docs/study/Debug/12-subagent/README.md`
- `docs/study-Interview/12-subagent/README.md`

## 开发顺序为什么这样安排

角色定义先于加载器，加载器先于工具过滤；Runner 依赖前面三者；TaskManager 依赖 Runner；最后才把同步和后台能力暴露给模型与 TUI。这样每阶段只增加一种新概念，问题发生时容易定位，也不会把第 13、14 章的能力提前混进来。
