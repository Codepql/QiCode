# 10-Skills 开发分割

> 依据：`docs/plan/10-skills/`，并按第九章验收后的真实代码调整。当前只生成理解与分割文档，不创建源码或测试。

## 当前起点

| 规划假设 | 当前仓库事实 | 本章处理 |
| --- | --- | --- |
| Skill 使用 `.qicode/skills` | 当前用户配置约定是 `.QiCode` | 全部统一为 `.QiCode/skills` |
| `Tool` 还没有 `system` | `src/tools/types.ts` 已有 `system?: boolean` | 不重复开发，只验证其真实语义 |
| PromptBuilder 还没有 Skill 槽位 | `BuildOptions.skillSection` 与 priority 90 已存在 | 接入实际 Skill 清单 |
| App 仍在 `submit()` 逐条判断命令 | 当前已由 `handleSlashCommand()` 统一分发 | Skill 注册进 Registry，只扩展通用类型分发 |
| 可直接调用 `spawnSubAgent` | 当前仓库没有该函数，第十二章才规划通用 SubAgent | 本章实现 Skill 专用最小隔离运行器 |
| InstallSkill 属于只读系统工具 | 安装会访问网络并写项目文件 | 工具保持系统可见，但按 command 类进入权限链 |

## 依赖顺序

```text
阶段 1：Skill 数据契约与 Catalog
  -> 阶段 2：正文渲染、激活态与工具范围
  -> 阶段 3：LoadSkill 与两阶段上下文
  -> 阶段 4：Slash Command 和 TUI 接入
  -> 阶段 5：Fork 隔离执行
  -> 阶段 6：InstallSkill 安装链
  -> 阶段 7：统一测试、验收和学习文档
```

每一阶段开发完都要做面向初学者的总结：说明新增文件负责什么、核心函数如何改变状态、输入如何流向下一层，以及该阶段还不能完成什么。

## 第 1 阶段：Skill 数据契约与 Catalog

**背景目标：** 先解决“磁盘上的 Markdown 怎样成为程序能查询的 Skill”，此时不接 Agent、不改 TUI。

**预计文件：**

- 新建 `src/skills/skill.ts`：定义 `SkillMeta`、`Skill`、Inline/Fork Host 能力接口。
- 新建 `src/skills/catalog.ts`：解析 SKILL.md、扫描目录、处理覆盖和 mtime 热重载。

**实现任务：**

- 支持目录型 `<name>/SKILL.md` 与单文件型 `<name>.md`。
- 解析 `name`、`description`、`allowed_tools`、`mode`、`fork_context`、`model`。
- 先扫描 `~/.QiCode/skills`，再扫描 `<workDir>/.QiCode/skills`，项目级同名覆盖用户级。
- Catalog 分开保存元数据、正文、来源文件与最后加载 mtime。
- `get(name)` 发现 mtime 变大时重读；重读失败保留旧缓存。
- 单个文件损坏、缺少 frontmatter、名称非法或目录不存在时跳过，不阻断其他 Skill。
- 跳过符号链接候选，避免扫描越出 Skill 根目录。

**阶段完成标志：** Catalog 能稳定回答 `list/get/has`，且“项目覆盖用户”“坏文件隔离”“修改后热重载”三条语义明确。

**阶段总结必须回答：** `registered`、`discovered` 和 `active` 在 Skill 系统中分别指什么，为什么 Catalog 只负责前两者中的发现。

## 第 2 阶段：正文渲染、激活态与工具范围

**背景目标：** 让一个已经取得的 Skill 真正改变 Agent 下一轮上下文与工具集合，但暂时不提供 `/skill` 命令。

**预计文件：**

- 新建 `src/skills/executor.ts`：参数渲染、工具依赖检查、Inline 激活与 Fork prompt 构造。
- 修改 `src/agent/agent.ts`：接收激活态和工具过滤器，生成 Skill reminder。
- 视实现需要修改 `src/tools/registry.ts`：提供安全的过滤视图或工具存在性查询，不复制工具实例。

**实现任务：**

- `$ARGUMENTS` 全量替换；没有占位符且参数非空时追加 `User Request` 段。
- 激活前检查 `allowed_tools` 中每个名称都已注册，缺失时 fail-fast，不留下半激活状态。
- `activeSkills` 非空时，每轮在模型调用前拼出 `# Active Skills` reminder。
- 工具过滤同时作用于 schema 生成和工具执行入口；隐藏工具被模型伪造调用时也要返回错误。
- 系统工具始终保留在 schema 中，但真实执行仍经过 `PermissionChecker`。
- Skill 白名单与 Plan Mode、default 等权限模式取交集，不互相覆盖。
- 多次激活 Skill 时明确合并规则：激活 SOP 按名称累积；工具范围按交集收窄，避免后激活的 Skill意外扩大权限面。

**阶段完成标志：** 给定一个 Skill 和 Host，可以观察到“渲染正文 -> 激活 Map -> reminder -> 过滤后的工具定义”完整状态变化。

**阶段总结必须回答：** 为什么只过滤 `toolDefinitions()` 不够，以及工具可见性和工具权限的边界在哪里。

## 第 3 阶段：LoadSkill 与两阶段上下文

**背景目标：** 让模型先知道有哪些 Skill，再按需拉取完整 SOP；这是 Skill 从“文件加载器”变成 Agent 能力的关键阶段。

**预计文件：**

- 新建 `src/skills/load-skill-tool.ts`：实现模型可调用的 `LoadSkill`。
- 修改 `src/tui/app.tsx`：初始化 Catalog、注册工具、持有稳定的 Skill runtime refs。
- 复用 `src/prompt/builder.ts` 已存在的 `skillSection` 槽位；仅在发现接入缺陷时修改。

**实现任务：**

- 启动时把 Skill 的名称和描述渲染为短目录，传入 `buildSystemPrompt(..., { skillSection })`。
- `LoadSkill` 标记为 `system: true`、`category: "read"`，输入只包含 Skill 名称。
- 找到 Skill 时走 Inline 执行器并返回激活结果；找不到时返回错误和可用名称列表。
- Catalog、`activeSkills` 与工具过滤器使用稳定 ref，不能因 React 重渲染重新创建。
- 启动目录为空时不注入空标题，也不影响普通 Agent 对话。

**阶段完成标志：** 模型上下文只出现 Skill 名称和描述；调用 `LoadSkill` 后，下一轮才出现完整 SOP。

**阶段总结必须回答：** 为什么 Skill 清单适合固定 system prompt，而完整 SOP 适合每轮 reminder。

## 第 4 阶段：Slash Command 与 TUI 接入

**背景目标：** 让用户不依赖模型选择，能够直接输入 `/code-review` 激活 Skill，同时继续复用第九章的补全、帮助和分发链。

**预计文件：**

- 新建 `src/skills/commands.ts`：把 Catalog 条目转换成 `Command`，避免注册逻辑堆进 App。
- 修改 `src/commands/commands.ts`：增加 `/skills`，并为 Fork 命令预留统一类型。
- 修改 `src/tui/app.tsx`：调用注册函数，处理 `/skills` 与 Skill 命令结果。

**实现任务：**

- Inline Skill 注册为 `prompt`；Fork Skill 注册为 `skill_fork`。
- Skill 描述追加 `[skill]`，因此 `/help` 和输入补全能识别来源。
- 与内置命令、用户命令或已有别名冲突时跳过 Skill 命令，并给出可见诊断。
- `/skill <name> [args]` 作为统一短语法重写到同一 Registry 查找链，不新增逐 Skill 分支。
- `/skills` 只展示 Skill 名称、模式和描述，不展示完整 SOP。
- 动态模块优先使用现有 `registerActionHandler()` 接入本地动作。
- `App.submit()` 仍只负责“Slash 是否消费；否则启动普通 Agent”，不得重新堆积 Skill 名称判断。

**阶段完成标志：** `/help`、补全、`/skills` 和 `/name args` 使用同一份 Registry/Catalog 数据；未知 Skill 不会发给 LLM。

**阶段总结必须回答：** Catalog 与 CommandRegistry 为什么都保存“名称”，却不能合并成一个对象。

## 第 5 阶段：Fork 隔离执行

**背景目标：** 支持不污染主模型历史的一次性 Skill 任务，但只做第十章需要的最小能力。

**预计文件：**

- 新建 `src/skills/fork-runner.ts` 或在 `executor.ts` 中增加小型运行适配器，具体以实现时职责大小决定。
- 修改 `src/tui/app.tsx`：为 Fork Host 提供父消息快照、Provider、权限回调和 UI 回流能力。

**实现任务：**

- 为 Fork 创建独立 `Conversation` 和 `Agent`，复用 Provider、工作目录、工具实现和权限检查。
- `fork_context` 映射为 none、recent、full 三档父消息快照，作为子 prompt 前缀。
- 子 Agent 的 schema 和执行入口都受 `allowed_tools` 限制。
- 可选 `model` 只有在当前 Provider 能安全创建对应配置时才启用；不支持时明确报错，不静默假装已切换。
- 运行时显示明确状态；成功后只把最终文本追加到 TUI 消息，不写入主 `Conversation` 的模型历史。
- 失败或取消时恢复主输入状态，并显示可读错误。

**阶段完成标志：** 主对话历史在 Fork 前后不增加 SOP、工具调用和中间消息，只在 UI 中看到最终结果。

**阶段总结必须回答：** “UI 显示了一条 assistant 消息”和“主 Conversation 增加了一条 assistant 消息”为什么不是同一件事。

## 第 6 阶段：InstallSkill 安装链

**背景目标：** 让模型可以把一份 Skill 安装到项目目录，并在当前进程立即发现；本阶段风险最高，单独开发和 Review。

**预计文件：**

- 新建 `src/skills/install-tool.ts`：来源校验、下载限制、内容校验、原子安装与刷新回调。
- 修改 `src/tui/app.tsx`：注册安装工具，并在成功后刷新 Catalog 与命令注册。

**实现任务：**

- 目标固定为 `<workDir>/.QiCode/skills/<safe-name>/SKILL.md`。
- 本地来源必须解析真实路径并限制在工作区内；拒绝符号链接逃逸和路径穿越。
- 远程来源只允许 HTTPS，限制连接/总超时、响应体大小和重定向次数，每次重定向后重新校验协议。
- Skill 名称必须是安全 slug，不能被用来写出目标根目录。
- 先写同一目标根下的临时目录，完整校验成功后原子替换；失败不留下半安装目录。
- `InstallSkill` 为 `system: true` 以避免被 Skill 过滤掉，但分类为 `command`，继续进入第五章权限链。
- 安装成功后重新扫描 Catalog，只注册新增且不冲突的命令；同名已注册命令的 handler 在执行时从 Catalog 取最新版本，避免闭包持有旧正文。
- 本章只支持单份 SKILL.md，不实现 GitHub 目录递归、skills.sh 市场或压缩包。

**阶段完成标志：** 本地或 HTTPS 安装成功后 `/skills` 和补全立即可见；任何校验失败都不修改最终目录。

**阶段总结必须回答：** 为什么“下载成功”不等于“安装成功”，以及临时目录和原子 rename 分别防什么问题。

## 第 7 阶段：最终验收与学习交付

**背景目标：** 前六阶段只做实现和轻量静态检查；到本阶段才集中创建测试、跑全量验收并根据最终代码写学习文档。

**预计文件：**

- 新建 `tests/skills-catalog.test.ts`。
- 新建 `tests/skills-executor.test.ts`。
- 新建 `tests/install-skill.test.ts`。
- 按真实接入范围补充 `tests/tui/app.test.tsx` 与 Agent 相关测试。
- 新建 `docs/study/Debug/10-skills/README.md`。
- 新建 `docs/study-Interview/10-skills/README.md`。

**验收范围：**

- 解析、两级覆盖、坏文件隔离、mtime 热重载。
- `$ARGUMENTS`、多 Skill 激活、工具依赖 fail-fast、schema 与执行双重过滤。
- `LoadSkill` 成功/不存在、系统工具保留、权限链仍生效。
- Inline Slash、Fork 隔离、父上下文档位、取消和错误回流。
- 本地/HTTPS 安装、路径穿越、软链接、大小/超时/重定向、原子失败恢复和即时注册。
- 全量测试、typecheck、build、diff check 与真实 TUI 冒烟。

**执行约定：**

- 第 1—6 阶段不新建、不运行 `*.test.*`。
- 中间阶段只做必要的 `pnpm typecheck` 和 `git diff --check`；仓库当前没有 lint/prettier script，不虚构命令。
- 只有用户确认进入最终验收后，才集中补测试并运行测试套件。
- Debug/Interview 中的函数名、行号、测试数量必须来自最终代码，不提前编造。

**本章完成标志：** 代码、自动化验证和真实 TUI 主路径均有证据；学习文档能从启动扫描讲到 Inline/Fork/Install 的完整状态流，并诚实说明第十二章之前的 SubAgent 局限。

## 推荐开发顺序

```text
1. Catalog
2. Inline runtime
3. LoadSkill + 两阶段上下文
4. Slash/TUI
5. Fork
6. InstallSkill
7. 最终验收
```

这个顺序保证每次只引入一种新风险：文件解析、Agent 状态、模型工具、TUI 分发、隔离运行和外部安装不会混在同一次改动中。
