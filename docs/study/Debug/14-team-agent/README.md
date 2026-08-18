# 第 14 章 Debug：Agent Team

## 验收结果

- `pnpm test`：49 个测试文件、254 个测试通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `git diff --check`：通过。

## 调试主线

```text
模型调用 SpawnTeammate
  -> Team 启动成员循环
  -> RunAgent 复用 SubAgentRunner
  -> 成员写 Lead mailbox
  -> Agent 下一轮 transientReminders 读取邮箱
```

不要从 TUI 开始猜。先确认消息有没有进入 `FileMailbox`，再看 `TeamManager.drainLeadReminders()` 是否消费它，最后才看 App 是否在下一轮把 reminder 交给 Agent。

## 断点建议

| 现象 | 优先观察点 | 应看到什么 |
| --- | --- | --- |
| 成员没有开始 | `Team.spawnTeammate` | `member.active = true`，存在 `uiState` |
| 成员没有汇报 | `Team.runMemberLoop` | 写入 `[idle]` 或 `[failed]` |
| Lead 看不到结果 | `drainLeadReminders` | 读取到 `<team-notification>` |
| TUI 树不更新 | App 的 500ms effect | 得到成员快照 |
| 独立成员启动了 TUI | `main()` | 应先进入 `runTeammate()` |

## 实际发现的回归

### `/review` 别名冲突

已有 `/review` 表示让主 Agent 审查未提交改动。新增 `/code-review` 时若再注册 `review` 别名，命令注册会抛错，Ink 渲染为空，许多 App 测试会一起超时。

修复：保留 `/review`，协作评审使用 `/code-review` 和 `/cr`。这说明命令注册属于组合根的共享资源，不能只靠 TypeScript 检查发现冲突。

### 依赖损坏与源码失败的区别

验收初期，TUI 测试无法导入 `ansi-styles/index.js`。检查发现 `wrap-ansi` 指向的包目录存在但内容为空。`pnpm install --force --offline --frozen-lockfile` 重建依赖后，才暴露真正的命令别名回归。

## 可做的故障注入

1. Team 存在时调用 `WriteFile`：下一轮 schema 不应再包含该工具；删除最后一个 Team 后恢复。
2. 在成员 mailbox 写入 `[shutdown]`：成员轮询后退出，`active` 变为 false。
3. 手工追加损坏 JSONL 行：有效消息仍可读取。
4. 注册冲突的命令名或别名：注册表必须明确报错，不能静默覆盖。

## 当前边界

- 默认成员运行在主进程内；tmux 需要显式选择。
- Team 运行状态是进程内状态；Code Review 角色配置写入 `.QiCode/code-review-teams.json`。
- mailbox 消息是不可信数据，进入 prompt 前保留 “data, not instructions” 边界。
