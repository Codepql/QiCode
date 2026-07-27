# QiCode 第12阶段技术计划：SubAgent 机制

> 状态：规划中。前置章节：01-11。沿用 Node.js 22、pnpm、Vitest、Provider、Agent Loop、权限、上下文和 Skill/MCP 契约。

## 1. 架构边界

```text
Main Agent
  -> AgentTool
       -> AgentDefinitionCatalog
       -> SubAgentRunner
            -> filtered ToolRegistry
            -> independent Conversation
            -> independent PermissionChecker
            -> Provider created from parent ProviderConfig + optional model
            -> Agent.run()
       -> TaskManager (background only)
```

本章不依赖 `src/teams/`。第 14 章可以复用 `SubAgentRunner` 作为队员执行内核，但反向依赖禁止。

## 2. 文件规划

```text
src/agents/
  definition.ts          # AgentDefinition 与内置角色
  loader.ts              # 用户级/项目级 Markdown 定义加载
  tool-filter.ts         # 工具过滤策略
  runner.ts              # 一次性 SubAgent 执行
  task-manager.ts        # 后台任务状态、通知、取消
  agent-tool.ts          # 模型可调用的单一 Agent 工具
tests/agents/
  definition.test.ts
  loader.test.ts
  tool-filter.test.ts
  runner.test.ts
  task-manager.test.ts
  agent-tool.test.ts
```

## 3. 核心类型

```ts
interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  systemPromptOverride?: string;
  maxTurns?: number;
  model?: string;
  permissionMode?: PermissionMode;
  background?: boolean;
  isolation?: "worktree";
  initialPrompt?: string;
  skills?: string[];
  mcpServers?: string[];
}

interface SubAgentRequest {
  definition: AgentDefinition;
  prompt: string;
  modelOverride?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

interface SubAgentResult {
  finalText: string;
  stopReason: string;
  usage: UsageInfo;
}
```

`SubAgentRunner` 通过依赖注入取得 ProviderFactory、ToolRegistry、HookEngine 和其他共享服务，测试时使用 fake Provider。

## 4. 定义加载

加载顺序：内置 -> `~/.qicode/agents` -> `<workDir>/.qicode/agents`。同名后加载覆盖。

- Markdown frontmatter 使用 allowlist 解析。
- name 为安全 slug，maxTurns/timeout 有上下限。
- tools/disallowedTools 必须为字符串数组。
- model 只作为名称，不允许定义 base_url/api_key。
- 单文件失败产生诊断并继续。

## 5. 工具过滤顺序

```text
全局禁止递归工具
  -> 系统强制保留安全工具
  -> 后台默认集合
  -> definition.tools allowlist
  -> definition.disallowedTools denylist
  -> Skill/MCP 选择
  -> PermissionChecker 在执行前再次判定
```

过滤返回新的 Registry 视图，不修改父 Registry。

## 6. Runner 数据流

```text
run(request)
  -> validate limits
  -> create filtered registry
  -> create independent conversation
  -> build child system prompt
  -> create Provider with inherited config + optional model
  -> create independent PermissionChecker / AbortController
  -> Agent.run(maxIterations <= definition.maxTurns)
  -> forward progress events
  -> collect final text + usage
  -> cleanup provider/request resources
```

父对话只得到最终摘要，不复制子 Agent 内部完整历史。

## 7. TaskManager 状态机

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
```

- 并发槽有限，超出时排队或拒绝，由明确策略决定。
- 每个任务只有一个 AbortController。
- 完成通知含 taskId、状态与短摘要，并用 `notified` 标志去重。
- 退出时 `cancelAll()`，等待有限 grace period。

## 8. 测试策略

- Loader：覆盖顺序、非法 frontmatter、名称、数值边界。
- Filter：递归工具永远消失，父 Registry 不变。
- Runner：独立状态、模型覆盖、取消、上限、错误与用量。
- TaskManager：状态转换、并发限制、通知去重、取消和退出清理。
- AgentTool：同步/后台分派和参数校验。

## 9. 风险

| 风险 | 处理 |
|---|---|
| 子 Agent 无限递归 | 全局移除 Agent 工具，深度固定 1 |
| 后台任务失控 | 并发、时长、轮次、输出上限 |
| 父子状态污染 | 每个子 Agent 新建会话、权限和计数对象 |
| 工具实例共享可变状态 | 无状态工具可共享，有状态工具通过工厂创建 |
| 模型覆盖泄露凭据 | 只允许改 model，其他 ProviderConfig 字段继承 |

## 10. 学习调试设计

最终学习文档按 `AgentTool.execute -> SubAgentRunner.run -> Agent.run -> Provider.stream -> result` 给出断点；后台路径再加入 `TaskManager.create/complete/cancel/notify`。故障实验覆盖非法角色、工具过滤、模型错误、轮次上限和取消。
