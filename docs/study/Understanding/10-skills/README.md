# 10-Skills Start：开发前理解

## 背景：为什么有了 Slash Command，还需要 Skill

第九章解决的是“用户输入 `/xxx` 后，程序怎样找到并分发命令”。它建立了 `CommandRegistry`，也把本地命令、UI 动作和 prompt 命令分开了。

但 `/review` 这一类 prompt 目前仍写在 TypeScript 源码中。要修改审查步骤，必须修改代码并重新构建；模型执行这段 prompt 时，也会看到当前会话的全部工具。随着 MCP 工具增多，工具 schema 会越来越大，模型更容易选错工具。

第十章要把一类可复用任务从源码中搬到 Markdown：

```text
.QiCode/skills/code-review/SKILL.md
  = 元数据（名称、描述、允许的工具、执行模式）
  + Markdown 正文（完成任务的 SOP）
  + 可选的同目录参考资料
```

因此，Skill 不是一个新的 LLM，也不是 MCP 工具。它是一份可发现、可激活、可重复执行的任务说明书。

## 本章最终要解决什么

完成后，QiCode 应该具备下面这条完整链路：

```text
启动
  -> 扫描用户级与项目级 .QiCode/skills
  -> SkillCatalog 保存 Skill 元数据和文件位置
  -> 名称、描述进入可用 Skill 清单
  -> 每个 Skill 注册为 Slash Command

触发 /code-review 或模型调用 LoadSkill
  -> Catalog 按名称取得最新 SKILL.md
  -> 渲染 $ARGUMENTS
  -> 校验 allowed_tools 是否真实存在
  -> 激活 SOP，并收窄模型可见的工具
  -> Agent 下一轮把已激活 SOP 作为 system reminder 注入
```

这里的重点不是“能读取一个 Markdown 文件”，而是建立一条从磁盘定义、运行时激活到 Agent 上下文生效的闭环。

## 两阶段加载到底是什么意思

Skill 有两种信息量：

1. 第一阶段只让模型看到名称和简短描述，例如 `code-review — Review the current diff`。
2. 第二阶段只有真正选中 Skill 后，才把完整 SOP 放进 Agent 上下文。

这样做是为了控制上下文体积。假设有 30 个 Skill，每个正文 1,000 token，如果启动时全部塞进 system prompt，会固定消耗约 30,000 token；两阶段加载只固定携带一份很短的目录。

“Catalog 已读取文件”和“正文已经进入模型上下文”不是一回事：Catalog 负责保存与查询，`activeSkills` 才代表本轮 Agent 真正需要遵循哪些 SOP。

## Inline 与 Fork 的区别

### Inline：在主 Agent 中继续完成任务

Inline 是默认模式。Skill 正文会变成主对话中的任务，并被记录到 `activeSkills`。Agent 每次请求模型前都临时构造一份 reminder，使 SOP 持续生效但不重复写进 Conversation，直到进程结束或后续实现明确清理它。

它适合需要继承当前对话、继续修改当前工作区的任务，例如“按项目约定补全这个接口”。

### Fork：用隔离的对话完成一次任务

Fork 会创建一份独立 `Conversation`，用同一个 Provider 和工作目录启动一次 Skill 专用 Agent。它可以读取父对话的零条、最近几条或较长历史，但执行过程不写进主对话历史；结束后只把最终结果显示回主界面。

它适合代码审查、方案评估等希望减少主对话立场干扰的任务。

第十章只实现“Skill 能隔离执行”的最小运行器。第十二章才会把角色、并发、后台任务和委派等能力抽象成通用 SubAgent 系统，两者不要提前混在一起。

## `allowed_tools` 是权限吗

不是。它解决的是工具可见性和依赖声明，不代替第五章权限系统。

```text
Skill allowed_tools
  -> 决定模型能看到、能请求哪些工具

PermissionChecker
  -> 决定一次真实工具调用是 Allow、Ask 还是 Deny
```

最终可执行范围应当是两者的交集。即使 Skill 声明了 `Bash`，危险命令仍会进入权限检查；如果 Skill 没声明 `WriteFile`，即使模型伪造了该工具调用，Agent 也必须拒绝执行，而不能只在 schema 中隐藏它。

`system: true` 也只表示系统工具不能被 Skill 的可见性过滤器藏掉。`LoadSkill` 可以是只读系统工具；`InstallSkill` 会写文件并可能访问网络，因此仍应按 command 类进入权限链。在 `bypassPermissions` 模式下是否免确认，继续遵循第五章已有语义。

## 四类核心状态由谁持有

| 状态 | 持有者 | 作用 |
| --- | --- | --- |
| Skill 文件缓存、mtime | `SkillCatalog` | 查询、覆盖与热重载 |
| 已激活 SOP | TUI 会话运行时传给 `Agent` | 每次模型请求临时生成 reminder，不持久化重复副本 |
| 工具过滤条件 | TUI 会话运行时传给 `Agent` | 同时限制 schema 与执行入口 |
| Slash Command 定义 | `CommandRegistry` | `/help`、补全与命令查找共用 |

Registry 不读取 Markdown，Catalog 不操作 React，Agent 不负责扫描目录。每个对象只拥有自己生命周期内的状态，后续调试时才能判断问题出在“没有发现”“没有注册”“没有激活”还是“没有注入”。

## 与当前代码对齐后的关键修正

- Skill 路径统一为用户级 `~/.QiCode/skills/` 和项目级 `<workDir>/.QiCode/skills/`，不再引入小写 `.qicode`。
- `Tool.system` 和 `BuildOptions.skillSection` 已在当前代码中存在，本章只补齐实际运行链，不重复创建字段。
- 命令入口已经是 `App.submit() -> handleSlashCommand()`；Skill 通过 Registry 注册，不把每个 Skill 写成 `submit()` 里的新分支。
- 当前仓库还没有通用 SubAgent 实现，Fork 阶段先做 Skill 专用隔离运行器，避免提前侵入第十二章。
- 原规划把 `InstallSkill` 描述为只读工具不准确。安装会落盘，远程来源还涉及网络，因此应作为 command 类工具接受权限检查。
- 可用 Skill 的“名称 + 描述”必须进入启动上下文，否则模型不知道应该用哪个 Skill，两阶段加载就只剩下手动 Slash Command。

## 本章不做什么

- 不实现 Skill 市场、版本锁定、压缩包安装和自动更新。
- 不允许 Skill 自带可执行工具；它只能引用已经注册的内置或 MCP 工具。
- 不把 `allowed_tools` 当成安全沙箱。
- 不在第十章实现完整的多 Agent 编排。
- 不让一个损坏的 SKILL.md 阻止其他 Skill 或主程序启动。

## 学完本章应该能讲清楚什么

你不需要背 YAML 解析的每一行。更重要的是能解释：

1. Skill 为什么位于 Slash Command、Prompt、Agent Loop 和工具系统的交叉点。
2. Catalog 中“已发现”和运行时“已激活”为什么是两个状态。
3. 为什么完整 SOP 要按需进入 reminder，而不是启动时全部写进固定 system prompt。
4. 为什么工具过滤只能减少工具面，不能取代权限判断。
5. Inline 为什么污染主上下文但能继承任务状态，Fork 为什么隔离但需要显式选择父上下文。

一句话概括本章：第十章把可复用任务从硬编码 prompt 变成可发现、按需激活、工具范围受控的 Agent 能力包。
