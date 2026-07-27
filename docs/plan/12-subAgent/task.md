# QiCode 第12阶段任务清单：SubAgent 机制

> 状态：未开始。用户明确说“开发第 12 章”后执行。所有命令使用 pnpm，行为任务测试先行。

## 1. 任务总览

| 任务 | 结果 |
|---|---|
| T1 | 定义 AgentDefinition 与三个内置角色 |
| T2 | 实现定义加载、覆盖与诊断 |
| T3 | 实现工具过滤视图 |
| T4 | 实现 SubAgentRunner |
| T5 | 实现 TaskManager |
| T6 | 实现单一 AgentTool |
| T7 | 接入主 Agent/TUI 与退出清理 |
| T8 | 集成验证、学习文档和质量检查 |

## 2. T1：定义与内置角色

**文件：** `src/agents/definition.ts`、`tests/agents/definition.test.ts`

- 先测试字段默认值、三个内置角色和数值上限。
- 定义不包含 Team 类型或 mailbox 字段。
- `maxTurns` 默认有限。

## 3. T2：定义加载器

**文件：** `src/agents/loader.ts`、`tests/agents/loader.test.ts`

- 测试内置/用户/项目覆盖顺序。
- 测试安全 slug、allowlist frontmatter、非法文件诊断。
- 不允许配置 api_key/base_url。

## 4. T3：工具过滤

**文件：** `src/agents/tool-filter.ts`、`tests/agents/tool-filter.test.ts`

- 测试 `Agent` 永远不可见。
- 测试后台集合、allowlist、denylist、Skill/MCP 选择。
- 返回新 Registry 视图，不修改父 Registry。

## 5. T4：SubAgentRunner

**文件：** `src/agents/runner.ts`、`tests/agents/runner.test.ts`

- 使用 fake Provider 先测独立 Conversation、权限、用量和最终结果。
- ProviderConfig 只允许 model 覆盖。
- 测试 timeout、AbortSignal、轮次与输出上限。
- 进度事件通过回调上抛，不写进父 Conversation。

## 6. T5：TaskManager

**文件：** `src/agents/task-manager.ts`、`tests/agents/task-manager.test.ts`

- 测试 queued/running/completed/failed/cancelled。
- 测试并发限制、查询、取消、通知去重和 `cancelAll`。
- 任务结果只保存有限摘要，不无限积累事件。

## 7. T6：AgentTool

**文件：** `src/agents/agent-tool.ts`、`tests/agents/agent-tool.test.ts`

- schema 只有一个 `Agent` 工具，角色通过 `subagent_type` 选择。
- 同步路径调用 Runner，后台路径调用 TaskManager。
- 参数、未知角色和模型错误返回结构化 ToolResult。
- 不包含 `team_name` 分支。

## 8. T7：主流程接入

**文件：** `src/tui/app.tsx`、`src/main.tsx`

- 注册 AgentTool 和后台任务查询/取消入口。
- TUI 展示独立进度，不重复提交消息。
- 主 Agent 每轮前提取一次后台完成通知。
- 退出时取消全部任务并有限等待。

## 9. T8：最终验证

```text
pnpm typecheck
pnpm test
pnpm build
```

- 同步 explore 完成一次只读任务。
- 后台任务完成、查询、取消各验证一次。
- 子 Agent 尝试调用 Agent 工具时被过滤。
- 多任务达到并发上限时行为符合策略。
- 父子历史、权限和 token 不互相污染。

## 10. 学习文档任务

根据最终代码生成问题导向文档，包含真实文件/行号、同步与后台两条调用链、断点、变量、五个故障实验和一个自定义角色练习。

## 11. 开发开始条件

- [ ] 用户明确说“开发第 12 章”。
- [ ] 01-11 契约已完成或有测试替身。
- [ ] 本章不包含 Team/信箱/长驻队友实现。
