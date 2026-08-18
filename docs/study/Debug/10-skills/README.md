# 第十章 Debug：Skill 运行时

Skill 不是“把一段 Markdown 发给模型”这么简单。它要同时解决三件事：从磁盘发现可信的 SOP、把 SOP 持续放进 Agent 的每一轮上下文、并且把 SOP 声明的工具范围变成真实的执行边界。

## 先画出运行链

```text
.QiCode/skills/<name>/SKILL.md
  -> SkillCatalog.load(workDir) 解析并按「项目覆盖用户」建索引
  -> /<name> 由 registerSkillCommands 投影成命令
  -> inline: runInline -> activeSkills + ToolFilter
  -> Agent.run 每一轮 buildActiveSkillsReminder + toolDefinitions
  -> 模型只能看见、且 executeBatch 只会执行允许的普通工具

fork: runFork -> App.runForkSkill -> runSkillForkAgent
  -> 新 Conversation + 新 Registry + 新 Agent
  -> 结果只作为 UI 消息显示，不写回主 Conversation
```

这张图的关键是“双重限制”：`toolDefinitions()` 在模型请求前隐藏 Schema，`Agent.executeBatch()` 在模型仍然伪造工具名时拒绝执行。前者减少模型误用，后者才是安全边界。

## 从一个实际例子跟

假设 `.QiCode/skills/reviewer/SKILL.md` 写着：

```md
---
name: reviewer
description: review a change
allowed_tools: [Read, Grep]
---
先阅读 $ARGUMENTS，再按风险排序输出问题。
```

输入 `/reviewer src/agent/agent.ts` 后：

1. `App.handleSlashCommand()`（`src/tui/app.tsx`）从 `CommandRegistry` 找到动态注册的 `reviewer` 命令。
2. `registerSkillCommands()`（`src/skills/commands.ts`）的 handler 调 `runInline()`。
3. `runInline()`（`src/skills/executor.ts`）先用 `assertAllowedToolsExist()` 确认 `Read`、`Grep` 真在 Registry；失败时不激活 Skill，避免“提示词说能做、运行时做不了”。接着 `renderSkillBody()` 把 `$ARGUMENTS` 替换为路径。
4. `createSkillRuntime()`（`src/skills/runtime.ts`）持有的 `activeSkills` Map 保存正文，同时把白名单变成过滤函数。多个激活 Skill 有白名单时，`intersectToolFilters()` 取交集；没有白名单不是“禁止全部”，而是“不新增限制”。
5. 下一轮及以后，`Agent.run()`（`src/agent/agent.ts`）调用 `buildActiveSkillsReminder()`，因此 SOP 不会只在第一轮生效。
6. `toolDefinitions()` 只给模型 `Read`、`Grep` 和系统工具的 Schema；如果模型仍调用 `Bash`，`executeBatch()` 返回错误 ToolResult，而不会触碰 `Bash.execute()`。

## 关键文件与该看什么

| 文件 | 函数 | 观察点 |
| --- | --- | --- |
| `src/skills/catalog.ts` | `SkillCatalog.load()`、`get()`、`parseSkillFile()` | 两个根目录扫描顺序、名称冲突、mtime 变化后才重载 |
| `src/skills/executor.ts` | `runInline()`、`runFork()`、`intersectToolFilters()` | 激活前校验、`$ARGUMENTS` 渲染、白名单交集 |
| `src/skills/runtime.ts` | `createSkillRuntime()` | 哪些状态属于一个 TUI 会话：catalog、activeSkills、filters |
| `src/skills/load-skill-tool.ts` | `LoadSkillTool.execute()` | 模型按需加载 Inline Skill 时走的同一套逻辑 |
| `src/skills/fork-runner.ts` | `runSkillForkAgent()`、`createForkRegistry()` | 为什么 fork 没有复用主 Conversation，也不复用有闭包状态的系统工具 |
| `src/skills/install-tool.ts` | `InstallSkillTool.execute()`、`downloadHttpsText()` | 本地路径边界、HTTPS/重定向/体积限制、临时目录 rename |
| `src/agent/agent.ts` | `toolDefinitions()`、`executeBatch()` | Schema 隐藏和执行拒绝这两层防线 |

## 推荐断点

1. 在 `SkillCatalog.load()` 观察 `byName`：先放一个用户级和一个项目级同名 Skill，项目项应该覆盖。
2. 在 `runInline()` 观察 `body`、`allowedTools`、`host.toolRegistry().get(...)`。这里最容易分清“Skill 描述了工具”和“项目真的注册了工具”。
3. 在 `createSkillRuntime()` 的 `setToolFilter()` 观察 `filters` 与 `combinedFilter`。连续执行两个不同白名单 Skill，最后允许的是交集。
4. 在 `Agent.toolDefinitions()` 观察返回数组；再让 Fake Provider 故意请求被隐藏的工具，在 `executeBatch()` 确认没有进入对应 `tool.execute()`。
5. 在 `runSkillForkAgent()` 观察新建的 `conversation`、`registry`、`activeSkills`。它们应与主会话对象不同。
6. 在 `InstallSkillTool.execute()` 观察 `source`、`normalized.name`、`target`。成功前不会出现最终的 `<name>` 目录。

## 故障注入练习

### 1. Skill 写了不存在的工具

把 `allowed_tools` 改成 `[Read, ImaginaryTool]`，再执行 `/reviewer`。

预期：`runInline()` 在激活前报 `not registered`；`activeSkills` 不增加。这不是加载失败，而是防止错误 SOP 静默污染后续回合。

### 2. 验证模型绕过 Schema 也执行不了

用测试中的 Fake Provider 返回 `Bash` tool call，同时激活只有 `[Read]` 的 Skill。

预期：模型侧 Schema 看不到 `Bash`，即使强行构造调用，`executeBatch()` 仍返回 error ToolResult；`Bash.execute()` 调用次数为 0。

### 3. 验证项目级覆盖

在用户 `.QiCode/skills/reviewer/SKILL.md` 和项目 `.QiCode/skills/reviewer/SKILL.md` 分别写不同正文。

预期：`SkillCatalog.get("reviewer")` 返回项目正文。覆盖按 Skill 名，不按文件路径；这样团队项目可以固定 SOP。

### 4. 验证安装器拒绝越界

让 `InstallSkill` 的 `source` 指向工作区外的临时文件，或将 `.QiCode/skills` 做成软链接。

预期：返回 `isError: true`，不创建最终目录。安装器只接受工作区内真实普通文件，避免通过配置把任意本地文件读入项目。

### 5. 验证 Fork 不污染主会话

执行一个 `mode: fork` 的 Skill，完成后检查主 `conversationRef.current.getMessages()`。

预期：主 Conversation 不多出子任务消息；界面中的结果来自 `forkUiMessages`。这保证“子 Agent 的草稿”不会成为主 Agent 的事实历史。

## 本章实际验收

```text
pnpm.cmd test       37 个测试文件、213 条测试通过
pnpm.cmd typecheck  通过
pnpm.cmd build      通过
git diff --check    通过
```

新增 `tests/skills.test.ts` 覆盖 frontmatter、项目覆盖和 mtime 重载、Inline 渲染与工具交集、Agent 的 Schema/执行双重限制、临时 reminder、`LoadSkill` 的 Inline/Fork 边界、命令投影、IPv4/IPv6 私网拒绝、HTTPS 重定向、超时、体积限制、重复安装保护、本地安装越界拒绝和 Fork 隔离。并修正了既有测试对真实用户 Memory 与 Windows 不可写 `/workspace` 的环境依赖。

仍需真人冒烟的项目：配置真实 Provider 后，在真实终端执行一个 Inline Skill、一个 Fork Skill 及一次 HTTPS 安装。自动化测试能证明状态和调用边界，不能替代真实模型对 SOP 的任务完成质量判断。
