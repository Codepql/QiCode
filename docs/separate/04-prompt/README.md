# 04-Prompt 开发拆分

> 本文依据 `docs/plan/04-prompt/spec.md`、`plan.md`、`task.md`、`check.md` 和当前源码划分开发批次。
>
> 拆分用于控制学习和开发节奏，不减少任何验收项。规划中的接口或文件不存在时，以当前代码为准校准；尤其是当前仓库没有 `src/agents/spawn.ts` 和 `src/teammate.ts`，不会为了匹配旧规划凭空创建无关模块。

## 拆分原则

第 04 章同时涉及提示词结构、运行环境、Plan Mode 提醒、Provider 缓存和 TUI 接线。如果一次完成，出现问题时很难判断是提示文本、消息历史还是厂商协议导致的。

因此按下面的依赖顺序开发：

```text
Section 统一结构（已完成）
        |
        v
PromptBuilder + 环境探测
        |
        +-----------> 固定提示接入 TUI/Agent
        |
        v
动态 reminder 构造与按轮注入
        |
        v
Provider 缓存标记与用量解析
        |
        v
关键工具规则强化
        |
        v
整章验收 + Debug/Interview
```

建议拆成 7 次开发。每次只完成一条能单独理解和验证的链路，并覆盖原 `task.md` 的 T1-T12。

## 第 1 次：Section 工厂与环境数据结构（已完成）

对应原任务：T1。

### 为什么单独拆

在写组装器之前，必须先定义“什么东西可以被组装”。如果没有统一的 `Section` 结构，Builder 只能认识某几个固定函数，新增 Skill、记忆或自定义指令时仍要修改核心算法。

这一阶段只建立提示词模块的公共语言，不改变 Provider，也不引入 Git 探测。

### 本次完成什么

- 定义 `Section`：名称、优先级和内容。
- 定义 `EnvironmentContext`：工作目录、平台、Shell、Git、模型和日期。
- 将提示词拆成身份、系统、任务、操作、工具、风格、输出、环境八个固定 Section。
- 旧 `buildSystemPrompt()` 暂时读取 Section 的 `content`，保证当前调用链继续通过类型检查。
- 新增聚焦测试文件，覆盖 Section 顺序契约和环境可选字段。

### 阶段结果

```text
identitySection() -> { name: "Identity", priority: 0, content: "..." }
usingToolsSection() -> { name: "UsingTools", priority: 40, content: "..." }
```

当前只是具备统一零件，尚未由统一 Builder 自动组装。

## 第 2 次：PromptBuilder 与环境探测（已完成）

对应原任务：T2、T10 中的 Builder 测试。

### 为什么单独拆

Section 解决“提示词由哪些模块组成”，Builder 解决“这些模块怎样稳定地拼起来”。环境探测也放在这一阶段，因为它最终产出一个 Environment Section，并且需要单独处理 Git 不可用、非仓库和超时降级。

### 本次完成什么

- 新建 `PromptBuilder`，支持链式添加 Section。
- 按 priority 排序、对 content 做 trim、跳过空模块、以固定空行拼接。
- 实现异步 `detectEnvironment(workDir)`，收集平台、架构、Shell、日期和 Git 信息。
- 实现新的 `buildSystemPrompt(env, opts?)`，预留 Skill、自定义指令和记忆三个空槽位。
- 用聚焦测试验证排序、跳空、结果稳定、可选 Section 和非 Git 降级。

### 阶段结果

新增一个提示模块时，只需要创建 Section 并挂载，不需要修改排序和拼接算法。

> 当前实现状态：已完成。`src/prompt/builder.ts` 负责组装与环境探测；本阶段尚未接入 TUI 和 Agent，接线留在第 3 次开发。

## 第 3 次：稳定提示词接入现有运行链

对应原任务：T9 中当前仓库真实存在的 TUI 接线部分，以及 T4 中需要校准的请求接口。

### 为什么单独拆

Builder 自己正确，不代表程序真的会使用它。本阶段只把新提示词接到当前真实调用链：`App -> Agent -> Provider`，并确认同一会话跨轮使用同一份 system prompt。

旧规划要求 Provider 构造器保存 system prompt，但当前代码的真实接口是 `Agent` 在每次 `stream()` 请求中传入 `systemPrompt`。本阶段会优先保持当前统一请求契约，除非代码证据表明必须调整。

### 本次完成什么

- TUI 初始化时异步探测环境并构建 system prompt。
- 把所选模型写入 EnvironmentContext。
- Agent 每轮继续传递初始化时得到的同一份提示词。
- 删除或收敛旧 `system-prompt.ts` 的重复拼接逻辑。
- 验证原有纯对话和 Agent Loop 不因异步初始化退化。

### 阶段结果

```text
启动时构建一次 system prompt
          |
          +-> 第 1 轮 Provider 请求
          +-> 第 2 轮 Provider 请求
          +-> 后续轮次仍复用同一份文本
```

## 第 4 次：Plan Mode 与通用 reminder 通道

对应原任务：T3、T8、T11，以及 T9 的 `/plan`、`/do` 接线。

### 为什么单独拆

固定 system prompt 与动态提醒的生命周期不同。Plan Mode 会在会话中进入、持续和退出，如果每次都改固定提示词，缓存前缀会变化；如果永久写入历史，又会积累过时提醒。

本阶段专门解决“哪一轮注入什么提醒、提醒如何进入模型消息”。

### 本次完成什么

- 扩展 `plan-mode.ts`：完整提醒、精简提醒、退出提醒和重新进入提醒。
- 按 iteration 控制完整/精简提醒频率。
- Agent 在每轮请求前通过统一 reminder 机制注入运行上下文。
- `/plan`、`/do` 切换时注入对应提醒。
- 用 Conversation 和 Agent 聚焦测试验证标签、注入时机和历史合法性。

### 阶段结果

固定 system prompt 保持不变，Plan Mode 的动态状态通过 `<system-reminder>` 单独传递。

## 第 5 次：Provider 缓存标记与缓存用量

对应原任务：T4、T5、T6。

### 为什么单独拆

缓存是协议层能力：Anthropic 使用显式 `cache_control`，OpenAI/兼容端点主要依赖稳定前缀并返回 cached token 字段。把它们提前混入 Builder 会让提示词模块了解厂商 JSON，破坏 Provider 抽象。

### 本次完成什么

- 为统一 `UsageInfo` 增加缓存读取和缓存创建 token。
- Anthropic 请求为稳定 system、工具定义和合适的历史前缀增加 ephemeral 标记。
- Anthropic 解析 cache read/cache creation 用量。
- OpenAI Responses 和 Chat 路径解析各自 cached token 字段。
- 缺少缓存字段时按 0 处理，不中断流式回答。
- Provider 测试覆盖请求结构、用量映射和缺字段降级。

### 阶段结果

Agent 只看到统一用量：

```text
inputTokens
outputTokens
cacheReadInputTokens
cacheCreationInputTokens
```

它不需要知道这些数据来自 Anthropic 还是 OpenAI 字段。

## 第 6 次：关键工具约定双重强化

对应原任务：T7、AC7。

### 为什么单独拆

系统提示词告诉模型全局做事原则，工具 description 在模型选择某个工具时再次提供局部规则。像“编辑前先读取”“不要用 Bash 代替专用工具”这类高频错误，只写一处仍可能被忽略。

这一阶段既检查文字约束，也检查代码层是否已经真正阻止未读取就编辑；不能把提示词当安全边界。

### 本次完成什么

- 统一检查 Bash、EditFile 等工具的中文 description。
- 在系统 Section 与工具 description 两处表达专用工具优先规则。
- 核对 EditFile 当前是否存在“先读取”代码约束；若没有，按 spec 增加最小执行层保护和测试。
- 保持 Tool schema 和 Agent Loop 行为不变。

### 阶段结果

```text
提示词：告诉模型应该怎样选择工具
工具描述：模型看到工具时再次提醒
执行校验：必要规则最终由代码兜底
```

## 第 7 次：整章验收与学习文档

对应原任务：T12、`check.md` 全部验收项。

### 为什么放在最后

缓存是否命中、Plan Mode 消息是否合法、固定提示是否稳定，必须在所有层接通后才能判断。最后一次不继续扩功能，只核对证据和诚实边界。

### 本次完成什么

- 运行类型检查和用户允许的聚焦/全量测试；不主动运行 build。
- 核对 Section 顺序、空槽跳过、环境降级、跨轮稳定和 reminder 历史合法性。
- 在用户配置可用时手工验证 Anthropic/OpenAI 的缓存字段和多轮对话。
- 校准 `task.md` 与 `check.md`，删除或标注不存在模块的过时任务。
- 代码完成后再生成 `docs/study/Debug/04-prompt/README.md` 和 `docs/study-Interview/04-prompt/README.md`。

### 阶段结果

能够证明本章完成的是“系统提示工程化与动态提醒通道”，并能诚实说明：缓存命中依赖模型供应商、端点和真实请求前缀，不保证所有兼容端点都返回缓存统计。

## 原任务覆盖关系

| 开发次数 | 覆盖原任务 |
| --- | --- |
| 第 1 次 | T1（已完成） |
| 第 2 次 | T2、T10（Builder 部分） |
| 第 3 次 | T9（真实存在的 TUI 接线）、稳定提示请求链 |
| 第 4 次 | T3、T8、T11、T9（模式切换） |
| 第 5 次 | T4、T5、T6 |
| 第 6 次 | T7、AC7 |
| 第 7 次 | T12、全部 `check.md`、Debug、Interview |

这 7 次覆盖现有 T1-T12。`src/agents/spawn.ts`、`src/teammate.ts` 当前不存在，因此不作为本章必须创建的文件；若后续章节真正加入子 Agent，再复用同一 PromptBuilder。

## 每次开发后的学习动作

每个阶段完成后，你只需要做四件事：

```text
1. 画出本阶段新增的数据流
2. 用四问解释新文件或核心函数
3. 在终端或断点中观察一个关键变量
4. 用自己的话说明为什么它不能和下一阶段混在一起
```

模块四问仍然是：

1. 这个文件负责什么？
2. 谁调用它？
3. 它调用谁？
4. 为什么需要它？

第 04 章整章完成前不生成 Debug 和 Interview；它们必须以最终代码、真实函数名和真实行号为准。
