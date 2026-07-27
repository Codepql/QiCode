# QiCode 第09阶段完成检查：Slash 命令体系

> 状态：未执行。只有用户明确说“开发第 09 章”并完成实现后，才按本清单验证。
>
> 需求依据：`spec.md`；技术依据：`plan.md`；实施依据：`task.md`。

> 验证策略：单测（pnpm test）覆盖命令加载器与渲染纯函数；类型层 `pnpm typecheck` 保证 4 类 dispatcher 分支签名一致；端到端 `pnpm dev` 在真实终端中跑出菜单与分发行为。

## 实现完整性

- [ ] `src/commands/commands.ts` 导出 `CommandType` / `CommandContext` / `Command` 三类型与 `CommandRegistry` 类（验证：`grep -nE "export (type|interface|class) (CommandType|CommandContext|Command|CommandRegistry)" src/commands/commands.ts` 至少 4 行命中）
- [ ] `CommandRegistry.register` 对名字冲突、别名冲突、name↔alias 交叉冲突四种情况都抛 `Error` 且消息含具体字符串（验证：临时写 `pnpm exec tsx -e` 脚本调两次同名注册看错误）
- [ ] `CommandRegistry.hasConflict` 非抛版本返回 `boolean`（验证：`grep -n "hasConflict" src/commands/commands.ts`）
- [ ] `parse` 纯函数实现且覆盖 `/`、`/foo`、`/foo bar baz`、非 `/` 起头四类输入
- [ ] `createDefaultRegistry()` 返回的 registry `listCommands() 与本章命令定义集合一致`（验证：`pnpm exec tsx -e 'import("./src/commands/commands.js").then(m => console.log(m.createDefaultRegistry().listCommands().length))'` 输出预期数量）
- [ ] 默认命令只引用截至第 08 章已经存在的能力；第 10/13/14 章命令尚未注册，但扩展 API 可测试。
- [ ] `loadUserCommands` 支持两级目录扫描（`~/.qicode/commands` 与 `<workDir>/.qicode/commands`），项目级覆盖用户级（验证：`grep -nE "homedir|workDir" src/commands/loader.ts` 命中两处）
- [ ] `renderBody` 在含 `$ARGUMENTS` 时全量替换、不含时按 `body + "\n\n" + args` 拼接、无参数返回 body
- [ ] `CommandUsageTracker` JSON 文件路径为 `<workDir>/.qicode/command_usage.json`

## 注册中心行为

- [ ] 名字冲突立即 `throw new Error`，消息含 `already registered` 与具体命令名
- [ ] 别名与已有命令名冲突时 `throw`，消息含 `collides with existing command name`
- [ ] `find` 同时按主名与别名查找命中
- [ ] `listCommands()` 输出按 `name.localeCompare` 字典序排序
- [ ] `complete(prefix)` 大小写不敏感，覆盖 name 与 alias 前缀匹配
- [ ] 动态加载器对 `hasConflict` 命中时 short-circuit 不调 `register`（验证：`grep -nE "hasConflict|find\(meta.name\)" src/tui/app.tsx` 至少 1 行命中）

## 命令分发与四类执行

- [ ] `handleSlashCommand(text)` 在 `parse(text) === null` 时返回 `false`
- [ ] `parsed.name === "mcp"` 提前短路，直接读 `mcpInfo` 输出，不进 registry 查找
- [ ] 未命中时 messages 末尾追加 `Unknown command: /<name>` 一条 system 消息
- [ ] `local` 命令：handler 返回字符串直接 push 为 system 消息，`convRef.current.addUserMessage` 未被调用，`runAgentLoop` 未启动
- [ ] `local_ui` 命令：handler 返回动作字符串后 dispatcher 在 `switch` 中按动作触发副作用（`clear`→清 messages、`quit`→`exit()`、`plan`→`setPermMode("plan")`、`compact`→`forceCompact`、`resume`→列/恢复 session 等）
- [ ] `prompt` 命令：handler 返回的文本同时 push 到 messages（role=user）、`convRef.current.addUserMessage` 与 `sessionMod.saveMessage`，然后调一次 `runAgentLoop()`
- [ ] 命中任一命令后 `usageTrackerRef.current.record(cmd.name)` 被调一次

## 当前内置命令的具体行为

- [ ] `/help` 列出全部命令，每行 `/<name>, /<alias>... \n    <description>`，末尾追加 `Type /help <command> for details.`
- [ ] `/help <name>` 输出单条详情，含 `/<name> — <description>` 与（如有）`Aliases: ...` 行
- [ ] `/clear` 清空 messages、归零 `committedIndexRef.current`、重建 `ConversationManager`
- [ ] `/compact` 调 `forceCompact`，结果消息含 `Compact:` 前缀；boundary 通过 `sessionMod.saveCompactBoundary` 持久化
- [ ] `/session` 输出固定提示 `"Session is active. Use /resume to list past sessions."`
- [ ] `/plan` 把当前模式保存到 `prePlanMode`、切到 `plan` 模式、写出 plan 文件路径；若本会话曾退出过 plan 模式且 plan 文件存在则注入 `buildPlanModeReentryReminder` 提醒
- [ ] `/resume` 无参列出最近 10 个会话；带 id 时 `loadSession + rebuildFromSession` 还原会话并切换 `taskListRef`
- [ ] `/quit` 调 Ink `useApp().exit()` 关闭 TUI
- [ ] `/memory` 无参列出 `MemoryManager.getMemories()`；`/memory clear` 调 `mgr.clear()` 清空
- [ ] `/permission` 无参显示当前模式与切换说明；`/permission mode <m>` 切到指定模式
- [ ] 本章不存在绕过权限层直接执行 Git/Shell 的 `/worktree` 实现；该命令由第 13 章接入受控 Worktree 服务。
- [ ] `/review` 注入固定的"审查未提交改动"提示词，触发 `runAgentLoop()`
- [ ] `/rewind` 从 `FileHistory.getSnapshots()` 拿快照后激活 `RewindDialog`
- [ ] `/mcp` 输出 MCP server 数量、列表、总工具数

## 自动补全菜单（InputBox）

- [ ] 在 `InputBox` 中第一字符输入 `/` 后 `showDropdown=true`，菜单立即出现
- [ ] 空 query 时若提供 `usageTracker`，按 `getRecentlyUsed(5)` 把最近使用命令放到 `RECENTLY USED` 段顶部，其余在 `ALL COMMANDS` 段
- [ ] query 含空格时 `filteredCmds` 为空、菜单消失
- [ ] query 非空时按 5-tier 顺序：精确 name → 精确 alias → name 前缀 → alias 前缀 → Fuse 模糊
- [ ] Fuse 实例 keys 权重为 `name: 3`、`aliases: 2`、`description: 0.5`，`threshold: 0.4`
- [ ] 菜单最多展示 8 行（`slice(0, 8)`）
- [ ] 每行渲染 `<icon> /<name>  <description>`，icon 来自 `commandIcons[cmd.type]`
- [ ] 按 ↑↓ 在候选间循环切换 `dropdownIndex`
- [ ] 按 Enter 或 Tab 把 `"/" + selected.name + " "` 写回 lines[0]，菜单消失等待提交或继续输入参数
- [ ] 按 Esc 关闭菜单（设 `dropdownDismissed=true`），输入框文本保留
- [ ] 第一候选 name lower 以 query lower 开头时显示 dim 颜色 ghost text 补全后缀
- [ ] 删空输入框（全部退格）后菜单立即消失

## 命令使用追踪

- [ ] `CommandUsageTracker` 构造时若 `.qicode/` 不存在自动 `mkdirSync({ recursive: true })`
- [ ] `record(name)` 同步写盘到 `command_usage.json`，结构为 `{ <name>: { usageCount, lastUsedAt } }`
- [ ] `getScore` 使用 `count × max(0.5^(daysSince/7), 0.1)` 衰减公式
- [ ] `getRecentlyUsed(limit)` 仅返回 `score > 0` 的条目，按 score 降序截断
- [ ] JSON 文件损坏或不存在时 `load()` 静默吞错，tracker 起步为空 Map
- [ ] `save()` 失败时静默吞错，不阻塞 UI


- [ ] `<workDir>/.qicode/commands/foo.md` 自动加载为 `/foo` 命令，type=prompt
- [ ] 含 frontmatter `description` / `aliases` / `argument-hint` 三字段的 md 文件能正确解析
- [ ] 子目录路径以 `:` 命名空间化（`git/sync.md` → `/git:sync`）
- [ ] 用户命令与内置同名时保留内置命令、启动不中断，并显示冲突诊断。

## 编译与测试

- [ ] `pnpm typecheck` 整仓零类型错误
- [ ] `pnpm test -- tests/command-loader.test.ts` 三个 case 全绿
- [ ] `pnpm test` 全套测试通过（不引入新失败）
- [ ] `pnpm dev` 正常启动，未抛运行时错误

## 端到端场景

（pnpm + 真实终端）

> 准备：`pnpm install` 安装依赖后用 `pnpm dev` 启动；在 `<workDir>/.qicode/commands/test.md` 写入测试命令；保留至少一条 MEMORY.md 让 `/memory` 与 `/status` 的 Memories 计数非零。

### 场景 A：启动与 /help

- [ ] **A1** 启动 `pnpm dev`，输入框出现，状态栏显示当前 model 与 mode
- [ ] **A2** 键入 `/help` 回车，messages 区追加一条 system 消息含 `Available commands:` 标题，且命令集合与本章定义一致
- [ ] **A3** 键入 `/help compact` 回车，输出含 `/compact — Force context compaction` 与 `Aliases: c`

### 场景 B：纯本地命令

- [ ] **B1** `/status` 输出 10 行 key:value，Mode 与状态栏徽章一致；Tokens 为当前累计；Tools 为已注册工具数
- [ ] **B2** `/permission` 输出当前模式名（default / acceptEdits / plan / bypassPermissions）
- [ ] **B3** `/memory` 列出 MEMORY 条目；`/memory clear` 后再跑 `/memory` 显示无记忆
- [ ] **B4** `/session` 输出 `Session is active. Use /resume to list past sessions.`
- [ ] **B5** `/mcp` 输出 `MCP servers (N):` 列表或 `No MCP servers connected.`
- [ ] **B6** 上述命令跑完后状态栏 Tokens 计数无增加（local 不消耗 token）

### 场景 C：自动补全菜单

- [ ] **C1** 仅按 `/`，补全菜单立即显示，且包含本章全部内置命令
- [ ] **C3** 按 ↓ 切换高亮，按 Enter 把 `/<name> ` 写回输入框；再按 Enter 提交执行
- [ ] **C4** 输入 `/s` 后按 Esc，菜单消失但输入框仍含 `/s`
- [ ] **C5** 把 `/s` 全部退格删除后，菜单立即消失
- [ ] **C6** 在 `command_usage.json` 已有记录时，按 `/` 看到 `RECENTLY USED` 段顶部为最近用过的命令

### 场景 D：影响界面命令

- [ ] **D1** `/plan` 后状态栏切到黄色 `Plan on`；输入框上方 system 消息提示进入计划模式
- [ ] **D2** `/compact` 触发压缩，messages 出现 `Compacting conversation...` 然后 `Compact: ...` 总结
- [ ] **D3** `/clear` 后 messages 清空、状态栏 Tokens 计数归零
- [ ] **D4** `/quit` 关闭进程，shell 提示符回归

### 场景 E：提示词命令

- [ ] **E1** `/review` 注入审查请求并触发 `runAgentLoop`；messages 末尾追加 role=user 消息含 `git status` 与 `git diff` 关键字
- [ ] **E2** `/review focus on bash.ts` 注入文本末尾含 `Focus on: focus on bash.ts`

### 场景 F：用户自定义命令

- [ ] **F1** 在 `<workDir>/.qicode/commands/deploy.md` 写入 `---\ndescription: Deploy it\naliases: [d]\n---\nDeploy $ARGUMENTS to production.`
- [ ] **F2** 重启 TUI，按 `/` 看到 `/deploy` 出现在菜单中，描述为 `Deploy it`
- [ ] **F3** 跑 `/deploy staging` 触发 prompt 流程，messages 末尾 user 消息为 `Deploy staging to production.`
- [ ] **F4** 子目录命名空间：`<workDir>/.qicode/commands/git/sync.md` 加载后 `/git:sync` 可命中

### 场景 H：未命中与启动期冲突检测

- [ ] **H1** 键入未注册 `/foobar` 回车，messages 追加 `Unknown command: /foobar`，且 `convRef.current.addUserMessage` 未被调用、`runAgentLoop` 未启动
- [ ] **H2** 在 `createDefaultRegistry` 中临时把 `/help` 注册两次，启动时 `pnpm dev` 抛 `Error: Command 'help' already registered`，进程退出；还原后启动恢复正常

### 场景收尾

- [ ] 所有测试场景通过后清理临时改动（`<workDir>/.qicode/commands/test.md`、`command_usage.json` 测试数据）
- [ ] `git status` 仅显示本期目标内的改动
- [ ] 每个场景至少 1 张终端截屏或 capture 输出作为证据保留

## 学习与面试验收

- [ ] 学习文档来自最终代码，文件名、函数名和行号均已核对。
- [ ] 文档能从入口讲到本章核心行为完成，包含关键状态变化。
- [ ] 高频问题包含设计原因、替代方案、当前局限和继续追问。
- [ ] 调试步骤已实际走通，断点与观察变量有效。
- [ ] 至少三个故障实验可重复，并解释症状、根因和定位路径。
- [ ] 学习者完成一个独立小改动并通过测试与 Review。

## 完成准则

只有本清单适用项目全部完成，`pnpm typecheck` 与 `pnpm test` 均通过，端到端场景已有证据，且 `spec.md` 每项验收标准都有自动化或手工证据时，第 09 章才可标记完成。

## 模块扩展验收

- [ ] fake module 可通过公开接口注册命令、补全项和动作处理器。
- [ ] 第 09 章源码不导入 Skill、Worktree、Team 或 Code Review 模块。
- [ ] 模块命令与内置/用户命令冲突时有明确诊断。
