# 第九章 Debug：Slash 命令体系

本章的核心不是“识别 `/`”，而是让同一个输入框正确分流。调试时先问：这条输入应该只显示本地结果、改变 TUI 状态，还是作为真正用户问题发给 Agent？

## 主调用链

```text
InputBox 收到键盘输入
  -> `/` 时根据 CommandRegistry 显示候选
  -> Enter 提交给 App.submit()
  -> handleSlashCommand() 解析并查找命令
     -> local: setCompactNotice，不写 Conversation/JSONL
     -> local_ui: 在 App 执行 clear / plan / resume 等动作
     -> prompt: submit(prompt, true)，复用普通 Agent 回合
     -> unknown: 显示 Unknown command，不请求 LLM
```

## 关键函数

| 文件 | 函数 | 调试时看什么 |
| --- | --- | --- |
| `src/commands/commands.ts` | `CommandRegistry.register` | 主名与别名四类冲突是否在注册期暴露 |
| `src/commands/commands.ts` | `parseCommand` | `/name args` 是否正确切成 `name` 和 `args` |
| `src/commands/commands.ts` | `createDefaultRegistry` | `/help` 是否来自同一个 Registry，而非硬编码清单 |
| `src/commands/loader.ts` | `loadUserCommands` | 用户级、项目级目录的覆盖顺序和 Markdown 解析 |
| `src/commands/loader.ts` | `renderBody` | `$ARGUMENTS` 替换或参数追加是否符合预期 |
| `src/commands/usage-tracker.ts` | `getRecentlyUsed` | 使用次数与时间衰减后的排序 |
| `src/tui/input-box.tsx` | `dropdown` 的 `useMemo` | 候选、最近使用分段、前缀与模糊匹配 |
| `src/tui/app.tsx` | `handleSlashCommand` | 三类命令是否走到了正确副作用边界 |
| `src/tui/app.tsx` | `submit(rawText, bypassSlash)` | prompt 命令是否复用正常存档和 Agent 流程 |

## 为什么 local 结果不用 `Conversation.addSystemReminder`？

当前 `ConversationMessage` 只有 `user` 和 `assistant` 两种角色。`addSystemReminder` 实际会生成隐藏的 user 文本，目的是给模型补充规则，不是给用户显示命令结果。

因此 `/status`、`/help`、`/mcp` 的结果写入 `compactNotice`：用户立刻能看到，下一轮模型不会把这段本地查询当作上下文，更不会写入 JSONL。只有 `/plan` 和 `/do` 需要改变模型后续行为，才注入 reminder。

## 推荐断点

1. `InputBox` 的 `useInput`：输入 `/s` 后观察 `dropdown.commands` 与 `dropdownIndex`。
2. `handleSlashCommand`：观察 `parsed`、`command.type`、`command.name`。
3. prompt 分支：观察 `prompt` 和 `bypassSlash`。它为 `true` 才能保证自定义 Markdown 正文即使以 `/` 开头，也不会被二次当作命令。
4. `CommandRegistry.register`：注册用户命令时观察 `#commands`、`#aliases` 和冲突错误。
5. `loadUserCommands`：观察两个根目录、`byName`，确认项目级覆盖用户级。

## 故障注入实验

### 1. 命令名撞别名

在测试或临时代码中先注册 `compact`，别名为 `c`，再注册名为 `c` 的命令。

预期：`register` 立即抛出包含 `c` 的错误；不会等到用户输入时才发生覆盖。

### 2. 损坏的 frontmatter

在 `.QiCode/commands/demo.md` 写一个不合法 YAML 头。

预期：加载器把整份文件视为正文，其他命令仍会加载；不会让 TUI 启动失败。

### 3. 自定义命令正文以 `/` 开头

写一个 prompt 命令，其正文第一字符是 `/`。

预期：命中 `prompt` 分支后调用 `submit(prompt, true)`，正文作为用户任务进入 Agent，而不是再次分发为 Slash 命令。

### 4. 不存在的命令

输入 `/not-found`。

预期：界面显示 `Unknown command: /not-found`；fake Provider 的 Agent 请求数不增加。

## 本章实际验收

```text
pnpm.cmd test       36 个测试文件、192 个测试通过
pnpm.cmd typecheck  通过
pnpm.cmd build      通过
git diff --check    通过
```

自动化覆盖了 Registry 冲突、别名查询、解析、模块扩展、用户 Markdown 命令、使用频次、补全候选、本地命令不请求 Agent、prompt 命令请求 Agent、未知命令不请求 Agent，以及既有 MCP 回归。

未执行的手工项：配置真实 Provider 后在真实终端确认 ESC、上下键、Tab 和窄终端菜单视觉效果。Ink Testing Library 对单独 ESC 字节的模拟不稳定，不能把它当作真实终端行为的替代证据。
