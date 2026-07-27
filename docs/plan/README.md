# QiCode 01-14 规划总纲

> 状态：规划中。用户明确指定“开发第 N 章”前，不创建源代码、不安装依赖、不调用真实外部服务。

本文件定义 01-14 章共同遵守的工程基线、章节依赖和文档职责。章节文档与本总纲冲突时，
先修订规划再开发，不在实现阶段静默选择其中一套。

## 1. 阅读顺序

每章固定包含四份文档：

1. `spec.md`：做什么、为什么做、范围与验收标准。
2. `plan.md`：架构、接口、数据流、风险与技术取舍。
3. `task.md`：按依赖排序的实现任务和验证命令。
4. `check.md`：实现完成后的自动化、手工、回归和学习验收。

开发前按 `spec -> plan -> task -> check` 阅读；实现后按 `task -> check` 收集证据。

## 2. 统一工程基线

| 项目 | 统一约定 |
|---|---|
| 产品名 | QiCode |
| 私有目录 | `.qicode/`，用户级目录为 `~/.qicode/` |
| 语言 | TypeScript 7.0.2，严格模式；后续以 lockfile 中已验证版本为准 |
| 运行时 | Node.js 22 LTS |
| 包管理 | pnpm 10.14.0，`packageManager` 精确固定 |
| 开发运行 | `pnpm dev`，底层由 `tsx` 执行源码 |
| 类型检查 | `pnpm typecheck` |
| 测试 | `pnpm test`，底层使用 Vitest 4.1.10 |
| 构建 | `pnpm build`，由 `tsc` 输出 `dist/` |
| 生产运行 | `pnpm start`，由 Node 执行 `dist/main.js` |
| 锁文件 | `pnpm-lock.yaml` 必须提交，干净环境使用 `pnpm install --frozen-lockfile` |

禁止重新引入 Bun 命令、`Bun.*` API、`bun.lock`、`@types/bun` 或 Bun shebang。

## 3. Provider 基线

第 01 章确定 Provider 的稳定边界，后续章节只能向请求、事件或能力接口做兼容扩展：

- protocol 只有 `anthropic` 与 `openai`。
- OpenAI 官方与兼容服务都使用 `protocol: openai`，由 `base_url` 区分。
- 不存在 `openai-compat` 第三协议，也不同时维护 Responses/Chat Completions 两套 OpenAI Provider。
- 上层依赖统一 `Provider` 与 `createProvider`，不依赖具体 Provider 类。
- 第 02 章增加工具 schema、工具调用事件和工具结果消息块。
- 第 03 章的 Agent Loop 消费统一 Provider 事件，不把循环控制放入 Provider。
- 后续上下文、记忆、SubAgent 和 Team 只依赖统一 Provider 接口。

Provider 的六个配置字段保持：

```text
name / protocol / model / base_url / api_key / thinking
```

后续功能不得把权限、上下文窗口、MCP、Hooks、Skills、Team 等字段塞进 Provider 项。

## 4. 应用配置演进

第 01 章只有顶层 `providers`。后续章节可以增加独立的应用级配置区：

- 第 05 章：`permissions`。
- 第 06 章：`mcp_servers`。
- 第 11 章：`hooks`。
- 其他章节若需要配置，必须在本章 spec 中定义字段、默认值、合并语义和安全边界。

配置层可从第 06 章开始扩展为三级来源：

```text
~/.qicode/config.yaml
<repo>/.qicode/config.yaml
<repo>/.qicode/config.local.yaml
```

规则：

- `.local.yaml` 不提交。
- providers 按 `name` 合并，而不是整列覆盖。
- 密钥环境变量解析和脱敏规则沿用第 01 章。
- 每个新增顶层区独立定义合并策略；禁止通用深合并。

## 5. 命令体系演进

- 第 01 章只有 `/exit` 特判。
- 第 03-08 章如需要 `/plan`、`/compact`、`/resume` 等命令，只能加入一个最小内置命令分发层，
  不实现补全、别名、用户 Markdown 命令和使用追踪。
- 第 09 章把已有最小命令迁移到正式 `CommandRegistry`，并增加解析、补全、用户命令和追踪。
- 第 09 章迁移后删除旧特判，不能保留两套分发路径。

## 6. 章节路线

| 章节 | 主题 | 主要增量 |
|---|---|---|
| 01 | LLM 对话 | TUI、SSE、两种 Provider、多轮、thinking |
| 02 | Tools | 本地工具、工具 schema、协议工具调用与单轮闭环 |
| 03 | Agent Loop | ReAct 多轮、取消、上限、并行策略 |
| 04 | Prompt | 模块化系统提示、环境信息、缓存稳定性 |
| 05 | Auth | 路径沙箱、危险命令、HITL 权限决策 |
| 06 | MCP | 外部工具发现、连接管理、包装与权限复用 |
| 07 | Context | 工具结果预算、压缩、上下文过长恢复 |
| 08 | Memory | 项目指令、会话恢复、长期记忆与历史 |
| 09 | Slash | 正式命令注册、分发、补全和用户命令 |
| 10 | Skills | Skill 扫描、加载、执行与安装 |
| 11 | Hooks | 生命周期 Hook、条件和受控动作 |
| 12 | SubAgent | 角色定义、派生 Agent、后台任务与隔离策略 |
| 13 | Worktree | Git Worktree 生命周期和文件系统隔离 |
| 14 | TeamAgent | 长驻队员、信箱、团队后端与协作状态 |

原则：当前章只能依赖前置章节已经完成的契约，不能引用未来章节才会提供的实现；必要的占位必须
最小化并在未来章节明确迁移/删除。

## 7. 安全基线

- API Key、Token 和真实配置不得进入版本库、日志、TUI、错误详情或学习文档。
- 模型输出、MCP 输出、Hook 输出、Skill 内容和外部文件内容均视为不可信数据。
- 文件工具必须限制工作区路径并防止符号链接/路径穿越逃逸。
- Shell、Hooks、MCP、Skill 安装、Worktree 删除和 Team 外部后端必须有明确权限或安全策略。
- 网络请求有超时、取消、响应大小限制和重定向策略。
- 循环、重试、工具调用、SubAgent 和 Team 都必须有资源上限。
- 依赖变更审查 lockfile、安装脚本、来源和 `pnpm audit --prod` 结果。

## 8. 测试与验证基线

每个行为任务采用测试先行，按以下层级验证：

1. 单元测试：纯函数、状态机、解析器、规则引擎。
2. 本地集成测试：临时目录、本地 HTTP/SSE/MCP 服务、假 Provider、假工具。
3. TUI 组件测试：键盘、动态状态、错误与历史渲染。
4. 手工端到端：只用于真实终端、真实模型、tmux、Git Worktree 等环境行为。

每章完成时至少运行：

```text
pnpm typecheck
pnpm test
pnpm build
```

测试不得依赖真实 API Key；真实外部服务只用于最后的授权手工验收。

## 9. 学习与面试交付基线

每章实现完成后必须生成基于真实代码的学习文档，面向第一次 Agent 项目的学习者：

- 先回答面试问题，再连接到项目代码和调试实验。
- 解释完整调用链、核心类型、关键状态和设计取舍。
- 标出准确文件、函数和行号；规划阶段不得预填虚假行号。
- 每个核心路径给出断点、观察变量、正常值、异常含义和下一步追踪方向。
- 至少三个故障注入实验，说明症状、根因和定位过程。
- 高频问题提供一句话回答、项目回答、原理深挖、替代方案和当前不足。
- 每章包含一个学习者独立完成的小改动，随后进行代码 Review。

项目最终再生成跨章 `interview-guide.md`，覆盖 30 秒介绍、2 分钟介绍、架构白板、真实问题案例、
常见追问和诚实边界。

## 10. 开发门禁

只有用户明确说“开发第 N 章”后，才执行该章 `task.md`。单独说“开发”但未指定章节时，先确认
当前获批章节；不得一次性实现 01-14。
