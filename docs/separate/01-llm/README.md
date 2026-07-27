# 01-LLM 开发拆分

> 本文依据 `plan/01-llm/plan.md` 和 `plan/01-llm/task.md` 划分开发批次。
>
> 拆分不会改变需求、架构或验收标准，只用于控制每次开发范围和学习节奏。

## 拆分原则

本章拆分不是重新设计任务，也不是为了把过程切得越细越好。拆分遵循三个原则：

1. 保持 `task.md` 中 T1～T10 的依赖顺序。
2. 保持 `plan.md` 中配置、会话、SSE、Provider、TUI 等模块边界。
3. 每次结束后都应形成可测试、可解释的阶段成果。

原任务的主要依赖关系是：

```text
工程基础
  ↓
配置 + 核心契约
  ↓
SSE 流式基础
  ↓
Anthropic / OpenAI Provider
  ↓
TUI 静态组件
  ↓
完整对话状态机
  ↓
CLI 装配与整章验收
```

建议将 T1～T10 组合为 7 次开发。这 7 次覆盖原任务全部内容，不会遗漏规划，也不会提前实现后续章节功能。

## 第 1 次：工程基础与配置系统

对应原任务：T1、T2。

### 为什么这样拆

配置是 QiCode 启动后的第一项真实业务行为，但它依赖工程骨架。如果只完成 T1，程序只能输出版本信息，无法形成有意义的业务闭环。

将 T1 和 T2 放在同一次，可以得到第一个完整路径：

```text
命令行启动
  ↓
读取 YAML
  ↓
校验六个配置字段
  ↓
返回安全的 ProviderConfig
```

实际执行时仍然先完成并验证工程初始化，再开发配置模块，不会同时混写两部分。

### 本次完成什么

- Node.js、TypeScript 和 pnpm 工程骨架。
- 第 1 次使用无 JSX 的 `src/main.ts`；引入 Ink/React 时再迁移到 `.tsx`。
- 开发、测试、构建和生产运行脚本。
- YAML 配置读取和默认配置路径。
- `--config` 指定路径的基础解析能力。
- Provider 六字段校验。
- 环境变量形式的 API Key 解析。
- 配置错误分类和 API Key 脱敏。
- 配置模块单元测试。

### 阶段结果

- 项目能够开发、测试、构建和运行。
- 实际依赖版本记录在 `package.json` 与 `pnpm-lock.yaml`，规划不再强制旧版本假设。
- 合法配置能够解析为 `ProviderConfig`。
- 非法配置能给出安全、明确的错误。
- 本次不创建具体 Provider，也不调用 LLM API。

## 第 2 次：会话模型与 Provider 契约

对应原任务：T3。

### 为什么单独拆

会话类型和 Provider 接口是后续模块共同遵守的合同。Anthropic、OpenAI、TUI 和 SSE 都会依赖这套边界。

如果边写具体 Provider 边修改核心类型，协议字段很容易进入 Conversation 或 TUI，破坏 `plan.md` 规定的分层。

因此要先确定：

```text
Conversation 保存什么
Provider 接收什么
Provider 返回什么
TUI 可以看到什么
```

核心合同稳定后，再开发流式解析和厂商协议。

### 本次完成什么

- `ConversationMessage`、`TextBlock` 和 `ThinkingBlock`。
- 仅在当前进程内保存历史的 `Conversation`。
- `ChatRequest`、`StreamEvent` 和 `Provider` 接口。
- 统一 Provider 错误类型和安全错误格式化。
- 会话顺序、副本保护和 thinking 隐藏测试。

### 阶段结果

- 会话可以保存用户消息、助手文本和隐藏 thinking。
- Provider 接口与具体厂商无关。
- TUI 后续只处理统一事件，不认识厂商原始响应。

## 第 3 次：SSE、URL 与流式错误基础

对应原任务：T4，以及 T3 中与 Provider 响应相关的错误边界。

### 为什么单独拆

SSE 是两个 Provider 共同使用的基础设施，也是本章最容易出现边界错误的模块。

如果把 SSE 解析直接写入 Anthropic 或 OpenAI Provider：

- 两边会重复处理 chunk、换行和缓冲区。
- 发生错误时难以区分是流解析问题还是厂商 JSON 问题。
- 拆包、粘包和 UTF-8 边界很难单独测试。

本次要先证明：

```text
任意方式到达的网络字节
  ↓
稳定、完整的 SSEMessage
```

### 本次完成什么

- 通用 SSE 解析器。
- 流式 `TextDecoder`。
- 拆包、粘包、LF、CRLF 和多行 `data:` 处理。
- 注释、尾部事件和 UTF-8 跨 chunk 处理。
- 缓冲区、单行和单事件大小限制。
- `base_url` 安全规范化和资源路径拼接。
- 流式响应相关的统一错误。
- 完整的模拟字节流单元测试。

### 阶段结果

- 不调用真实 API，也可以验证全部流式边界。
- SSE 层不包含 Anthropic 或 OpenAI 条件分支。
- 两个 Provider 可以复用同一个解析器和 URL 工具。

## 第 4 次：Anthropic 与 OpenAI Provider

对应原任务：T5、T6。

### 为什么这样拆

两个 Provider 都建立在相同的会话合同和 SSE 解析器之上，它们共同解决一个模块目标：

> 把不同厂商的请求和响应转换为统一 `StreamEvent`。

放在同一个开发阶段，可以直接比较两种协议的认证方式、请求结构、事件格式和 thinking 差异，帮助理解 Provider 抽象的价值。

实际执行仍然是顺序开发：

```text
Anthropic Provider
  ↓ 测试通过
OpenAI Provider
  ↓ 测试通过
Provider 工厂
```

不会同时混写两个协议实现。

### 本次完成什么

- Anthropic Messages API 请求映射。
- Anthropic Headers、URL 和流式事件映射。
- extended thinking、signature 和跨轮历史映射。
- OpenAI Chat Completions 请求映射。
- OpenAI Bearer 认证、URL 和流式事件映射。
- OpenAI 官方地址和兼容端点支持。
- usage、结束事件和常见错误分类。
- `createProvider` 工厂。
- 两个 Provider 的本地模拟流测试。

### 阶段结果

```text
Anthropic 响应 ─┐
                ├─→ 统一 StreamEvent
OpenAI 响应 ────┘
```

协议层在本次完成，但暂时不接入完整 TUI 对话。

## 第 5 次：TUI 静态布局与基础交互

对应原任务：T7。

### 为什么单独拆

TUI 涉及 Ink、React 状态、终端布局和不可信文本渲染。如果直接与真实网络状态机同时实现，出现问题时很难判断：

- Provider 是否产生了事件。
- App 是否正确更新了状态。
- 组件是否正确渲染了状态。

因此本次先使用固定数据或 fake 数据验证：

```text
给定消息和界面状态
  ↓
终端是否正确显示
```

这样可以让布局和协议问题彼此独立。

### 本次完成什么

- 三行双栏启动 Header：左侧固定为 `/\_/\`、`( o.o )`、`> ^ <` 猫头，右侧为版本、`protocol · model` 和工作目录，并支持窄终端纯文本降级。
- Provider 选择界面。
- Chat View。
- Activity 和耗时显示。
- Status Bar。
- 输入框基础展示和键盘交互。
- 流式纯文本与完成态 Markdown 展示。
- ANSI、OSC 等危险终端控制字符清理。
- 窄终端和静态组件测试。

### 阶段结果

- 多个 Provider 可以通过键盘选择。
- 消息、状态和输入区域层次清楚。
- thinking 不会显示在界面上。
- 不可信文本不会改变终端状态。
- 本次不接完整多轮网络状态机。

## 第 6 次：完整流式对话与多轮状态机

对应原任务：T8。

### 为什么单独拆

这是配置、Provider、Conversation 和 TUI 的核心集成点，也是第 01 章最重要的开发阶段。

本次集中处理：

```text
idle → waiting → streaming → idle
```

如果同时加入 CLI 参数、真实配置联调和最终验收，出现故障时定位范围会过大。因此先使用 fake Provider 和本地 SSE 服务证明完整离线流程，再进入真实 API 联调。

### 本次完成什么

- 用户输入提交和空输入拦截。
- `Ctrl+J` 插入换行。
- Conversation 与 Provider 接入。
- 流式文本实时更新。
- thinking 和 signature 隐藏累积。
- usage 和耗时更新。
- 助手消息完成提交。
- 第二轮携带完整历史。
- `AbortController`、请求超时和取消。
- 部分响应保留和单轮错误恢复。
- `/exit`、`Ctrl+C` 和资源清理。
- App 状态机组件测试。

### 阶段结果

- 用户可以完成多轮流式对话。
- 流式期间不能重复提交。
- 单轮失败后可以继续使用。
- Anthropic thinking 被保存但不会展示。
- 第二轮请求包含第一轮历史。
- `pnpm dev` 从 `.QiCode/config.yaml`（项目优先、用户目录回退）读取真实 Provider，可进行真实流式多轮对话。

## 第 7 次：CLI 装配、真实联调与整章验收

对应原任务：T9、T10，以及 `check.md` 的整章验收。

### 为什么放在最后

CLI 装配依赖配置模块和完整 TUI，真实联调依赖两个 Provider 与对话状态机。本次不再增加核心功能，只验证之前的模块能否从真实入口协同工作。

最终验证分为三层：

```text
自动测试：证明代码行为
真实联调：证明实际协议和运行环境可用
手工验收：证明用户体验符合 spec
```

只有这三层证据完整后，本章才能标记完成。

### 本次完成什么

- `--config` 参数和默认配置路径。
- CLI 启动、错误退出和终端恢复。
- 无真实密钥的配置示例和运行说明。
- Anthropic 真实流式联调。
- OpenAI 或兼容端点真实流式联调。
- extended thinking 多轮验证。
- 完整类型检查、测试、构建和依赖安全检查。
- 配置、网络、SSE、thinking 和取消故障实验。
- `spec.md`、`task.md`、`check.md` 的最终逐项核对。
- 根据最终代码生成面试学习文档。

### 阶段结果

- `spec.md` 的验收标准都有证据。
- `task.md` 的 T1～T10 全部完成。
- `check.md` 全部通过。
- 第 01 章可以正式标记完成。
- 可以生成 `study-Interview/01-llm/` 中的真实代码学习资料。

## 原任务覆盖关系

| 开发次数 | 覆盖原任务 |
|---|---|
| 第 1 次 | T1、T2 |
| 第 2 次 | T3 |
| 第 3 次 | T4 |
| 第 4 次 | T5、T6 |
| 第 5 次 | T7 |
| 第 6 次 | T8 |
| 第 7 次 | T9、T10、`check.md` |

这套拆分完整覆盖 T1～T10 和 `plan.md` 中的所有核心模块。每次开发结束后必须停止，不自动进入下一次。

对应阶段代码完成后，再根据真实实现补充 `study/Debug/01-llm/`；整章完成后，再生成 `study-Interview/01-llm/`。
