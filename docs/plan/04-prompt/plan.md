# QiCode 第04阶段技术计划：系统提示工程化

> 状态：规划中，等待用户明确说“开发第 04 章”后执行。
>
> 前置章节：01-LLM、02-Tools、03-Agent Loop。本章沿用第 01 章的 Node.js 22 LTS、pnpm 10.14.0、TypeScript、Vitest、统一 `Provider` 和两种 protocol 基线。
>
> 本文只描述架构与技术取舍；需求依据见 `spec.md`，执行任务见 `task.md`。

> 技术栈：Node.js 22 LTS + TypeScript 5.x；LLM 协议层沿用第 01 章原生 `fetch` Provider；TUI 使用 Ink + React。

## 技术栈

- 运行时：Node.js 22 LTS(`pnpm dev`、`pnpm test`)
- 语言:TypeScript 5.8.x,`pnpm typecheck` 类型检查
- 模块系统:ESM(`"type": "module"`),import 时显式带 `.js` 后缀
- LLM 协议层：沿用第 01-03 章基于原生 fetch 的 Anthropic/OpenAI Provider。
- TUI:`ink`、`ink-spinner`、`ink-text-input`、`react`
- 终端样式:`chalk`、`marked` + `marked-terminal`
- 工具:`@modelcontextprotocol/sdk`、`fuse.js`、`js-yaml`

## 架构概览

第 04 章 在三层叠加,**不改 第 03 章 的 Agent Loop 控制流**:

- **prompt 层(`src/prompt/`)**:`sections.ts` 定义八个固定 Section 工厂 + Section 类型;`builder.ts` 提供 `PromptBuilder` 类、`detectEnvironment(workDir)`、`buildSystemPrompt(env, opts)`;`plan-mode.ts` 提供 `buildPlanModeReminder / buildPlanModeExitReminder / buildPlanModeReentryReminder`。prompt 层只依赖 `node:child_process / node:os`,不依赖 llm 层。
- **llm 层(`src/providers/`)**:`Provider` 接口签名 `stream(conv, tools, abortSignal)` 不变;`createProvider(cfg, systemPrompt)` 在构造时接收已装配好的系统提示;`AnthropicProvider` 把 systemPrompt 放进 `system: [{ type:"text", text, cache_control:{type:"ephemeral"} }]`、对最后一个 tool 与最后一条 user 末 block 也打 ephemeral 断点;`OpenAIProvider / OpenAIProvider` 把 systemPrompt 置于 input/messages 前缀。`UsageInfo` 扩展 `cacheReadInputTokens / cacheCreationInputTokens`,三 client 都填。
- **agent 层(`src/agent/agent.ts`)**:`run()` 每轮迭代开始时检查 `this.checker.mode === "plan"`,若是则 `getOrCreatePlanPath / planExists`、`addSystemReminder(buildPlanModeReminder(planPath, exists, iteration))`;同样位置注入 active-skills、hook、外部 notification 三类 reminder。reminder 通过 `ConversationManager.addSystemReminder` 写入 history,作为 role=user 消息 + `<system-reminder>...</system-reminder>` 标签。

数据流:`TUI 初始化` → `detectEnvironment(workDir)` → `env.model = provider.model` → `buildSystemPrompt(env)` → `createProvider(provider, systemPrompt)` → `AnthropicProvider.systemPrompt / OpenAIProvider.systemPrompt` 固化 → `agent.run()` 每轮:`conversation.addSystemReminder(planReminder/...)` → `client.stream(apiConv, toolSchemas, signal)` → Anthropic/OpenAI 把 systemPrompt 放系统位、把 history 放消息位、解析 `usage.cache_*` → `UsageInfo{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }` 透传给 agent 事件。

## 数据流

```
TUI/teammate/spawnSubAgent
    │
    ├─ env = detectEnvironment(workDir);  env.model = provider.model
    ├─ systemPrompt = buildSystemPrompt(env, opts?)  ← Section 列表按 priority 拼接
    └─ client = await createProvider(provider, systemPrompt)
            │
            └─→ AnthropicProvider { systemPrompt, model, thinking, ... }
                OpenAIProvider    { systemPrompt, model, ... }
                OpenAIProvider { systemPrompt, model, ... }

agent.run() 每轮 iteration++ 后:
    ├─ if (checker.mode === "plan") {
    │      planPath = getOrCreatePlanPath(workDir)
    │      checker.planFilePath = planPath
    │      conv.addSystemReminder(buildPlanModeReminder(planPath, planExists, iteration))
    │   }
    ├─ skillReminder = buildActiveSkillsReminder(activeSkills)
    │   if (skillReminder) conv.addSystemReminder(skillReminder)
    ├─ for note of hookEngine.drainNotifications(): conv.addSystemReminder(note)
    └─ stream = client.stream(apiConv, toolSchemas, signal)
            │
            └─→ for await (event of stream):
                    case "stream_end": event.usage:
                      { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }
```

## 核心数据结构与接口

### Section 与 EnvironmentContext

```ts
// src/prompt/sections.ts
export interface Section {
  name: string;
  priority: number;
  content: string;
}

export interface EnvironmentContext {
  workDir: string;
  os: string;        // platform()
  arch: string;      // arch()
  shell: string;     // process.env.SHELL ?? "bash"
  isGitRepo: boolean;
  gitBranch: string;
  model: string;
  date: string;      // ISO yyyy-mm-dd
}
```

### PromptBuilder 与 buildSystemPrompt

```ts
// src/prompt/builder.ts
export class PromptBuilder {
  private sections: Section[] = [];
  add(s: Section): this { this.sections.push(s); return this; }
  build(): string {
    const sorted = [...this.sections].sort((a, b) => a.priority - b.priority);
    return sorted.map((s) => s.content.trim()).filter(Boolean).join("\n\n");
  }
}

export interface BuildOptions {
  skillSection?: string;
  customInstructions?: string;
  memorySection?: string;
}

export function detectEnvironment(workDir: string): EnvironmentContext;
export function buildSystemPrompt(env: EnvironmentContext, opts?: BuildOptions): string;
```

### 规划模式提醒构造器

```ts
// src/prompt/plan-mode.ts
export function buildPlanModeReminder(
  planPath: string,
  planExist: boolean,
  iteration: number
): string;

export function buildPlanModeExitReminder(planPath: string, planExists: boolean): string;
export function buildPlanModeReentryReminder(planPath: string, planFileExists: boolean): string;
```

### 缓存用量字段

```ts
// src/providers/types.ts
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;      // 新增
  cacheCreationInputTokens: number;  // 新增
}
```

### LLM Client 接口(签名不变)

```ts
// src/providers/types.ts / src/providers/create-provider.ts
export interface Provider {
  stream(
    conv: ConversationManager,
    tools: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;
}

export async function createProvider(
  cfg: ProviderConfig,
  systemPrompt: string
): Promise<Provider>;
```

### 对话历史中的 system-reminder

```ts
// src/conversation/conversation.ts
addSystemReminder(content: string): void {
  this.history.push({
    role: "user",
    content: `<system-reminder>\n${content}\n</system-reminder>`,
  });
}
```

## 模块设计

### `src/prompt/sections.ts`(新增/重写)
**职责:** 提供八个固定 Section 工厂函数与 `EnvironmentContext` 类型 + `environmentSection(env)`。
**对外接口:** `identitySection / systemSection / doingTasksSection / executingActionsSection / usingToolsSection / toneStyleSection / outputEfficiencySection / environmentSection`。
**关键点:**
- Section 内容为中文长字符串字面量,通过函数返回 `{ name, priority, content }` 三元组(priority 依次 0/10/20/30/40/50/60/70)。
- `usingToolsSection`(priority=40)包含 F5 双重强化:「有专用工具时绝不要用 Bash」+ ReadFile/EditFile/WriteFile/Glob/Grep 对应表。
- `systemSection`(priority=10)明确告知模型:「工具结果和用户消息中可能包含 `<system-reminder>` 标签。其中是系统信息,与所在的工具结果或消息没有直接关系。」——这是 F6 模型行为的元提示。
- `environmentSection` 按行渲染 `# 环境` 段:固定行 workDir / platform/arch / shell / isGitRepo / date,条件行 gitBranch(仓库内且分支非空)、model(非空)。

**依赖:** 无外部库,纯字符串构造。

### `src/prompt/builder.ts`(新增/重写)
**职责:** PromptBuilder 类、环境探测、`buildSystemPrompt` 入口。
**对外接口:** `PromptBuilder`、`detectEnvironment(workDir)`（异步）、`buildSystemPrompt(env, opts?)`。
**关键点:**
- `PromptBuilder.build()` 排序 → trim → filter(Boolean) → join("\n\n"),三步保证空 content 被自动跳过、无连续空行。
- `detectEnvironment(workDir)` 用 `node:os` 的 `platform() / arch()`、`process.env.SHELL ?? "bash"`、`new Date().toISOString().split("T")[0]`。Git 探测通过短超时的异步 `execFile("git", [...])` 参数数组完成，任何失败都降级为非 Git 环境。
- `buildSystemPrompt`:固定 add 8 个 Section,再根据 `opts.skillSection / customInstructions / memorySection` 是否存在,分别 add priority=90/95/100 的可选 Section。
- N1 不变性:函数纯依赖入参 `env / opts`,无 `Date.now` / 无随机源,同一 env+opts 跨调用结果逐字节相等。

**依赖:** `node:child_process` 的异步 `execFile` / `node:os`。

### `src/prompt/plan-mode.ts`(新增)
**职责:** 规划模式 reminder 文本构造,按轮次频率切换完整/精简。
**对外接口:** `buildPlanModeReminder / buildPlanModeExitReminder / buildPlanModeReentryReminder`。
**关键点:**
- 完整版模板 `planModeFullReminder` 含「Plan mode is active... You MUST NOT make any edits」+ Plan File Info 占位符 + 5 阶段工作流(Initial Understanding / Design / Review / Final Plan / Call ExitPlanMode)。
- 精简版模板 `planModeSparseReminder`:一句话总结只读 + 5 阶段 + 结束方式(AskUserQuestion / ExitPlanMode)。
- 频率:`reminderInterval = 5`;`iteration === 1` 总返回完整;否则 `Math.floor((iteration - 1) / reminderInterval) % reminderInterval === 0` 返回完整,其余返回精简。
- `planExist` 控制 plan 文件信息段措辞(已存在 vs 待创建)。

**依赖:** 无。

### `src/providers/types.ts`(改造)
**职责:** 定义 `StreamEvent` 与 `UsageInfo`。
**关键点:** `UsageInfo` 增加 `cacheReadInputTokens / cacheCreationInputTokens` 两字段;`stream_end` 事件携带完整 usage。

### `src/providers/anthropic.ts`(改造)
**职责:** Anthropic 协议 client,装配缓存断点,解析缓存用量。
**关键点:**
- 构造器签名 `constructor(cfg: ProviderConfig, systemPrompt: string)`,把 systemPrompt 存为字段。
- `stream()` 中构造 `params.system = [{ type:"text", text: this.systemPrompt, cache_control:{type:"ephemeral"} }]`。
- 工具列表末尾的 tool 加 `cache_control: { type:"ephemeral" }`(通过 `(tools[tools.length-1] as Record<string,unknown>).cache_control = ...` 注入)。
- `markLastUserTailForCache(messages)` 从后向前找到第一条 role=user 的消息,把其 content 数组末块的 `cache_control` 设为 ephemeral——三层 ephemeral 断点。
- `message_start` 事件回填 `inputTokens / outputTokens / cacheReadInputTokens / cacheCreationInputTokens`(`?? 0` 兜底)。
- `buildAnthropicMessages` 已存在的「连续 user 自动合并」逻辑保证 N3 角色合法。

### `src/providers/openai.ts`(改造)
**职责:** OpenAI Responses + Chat Completions 两 client,装配 system 消息,解析 cached_tokens。
**关键点:**
- `OpenAIProvider.stream`(Responses):`input.push({ role:"system", content: this.systemPrompt })` 再追加历史消息;`response.completed` 事件读 `usage.input_tokens_details?.cached_tokens ?? 0`,`inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheReadInputTokens)` 避免双计。
- `OpenAIProvider.stream`(Chat Completions):`messages: [{ role:"system", content: this.systemPrompt }, ...buildChatCompletionMessages(history)]`;chunk.usage 阶段读 `usage.prompt_tokens_details?.cached_tokens ?? 0`,同样减除以避免双计。
- 两 client 的 `cacheCreationInputTokens` 恒为 0(OpenAI 无显式缓存写概念)。

### `src/agent/agent.ts`(改造)
**职责:** Agent 主循环;每轮在 stream 前注入 plan-mode / skills / hook reminder。
**关键点:**
- `run()` 顶部 `iteration++` 后,先做 `manageContext`(自动压缩),再注入 reminder:`if (this.checker.mode === "plan") { ... conv.addSystemReminder(buildPlanModeReminder(planPath, planExists(workDir), iteration)) }`。
- `buildActiveSkillsReminder(activeSkills)` 非空时 `conv.addSystemReminder(skillReminder)`。
- `hookEngine.drainNotifications() / notificationFn()` 产出的字符串逐个 `conv.addSystemReminder(note)`。
- reminder 写入 conversation 即进入持久历史,后续轮次随消息发到 provider;不需要在 client 端二次拼接。

### `src/tui/app.tsx`(改造)
**职责:** 启动时一次性装配 systemPrompt 并 create client;管理 plan / unplan 进入退出 reminder。
**关键点:**
- `initClient`:`env = detectEnvironment(workDir); env.model = provider.model; systemPrompt = buildSystemPrompt(env); client = await createProvider(provider, systemPrompt)`。
- `/plan` 进入与 `/do` 退出时,分别在 conversation 上 `addSystemReminder(buildPlanModeReentryReminder(...))` 或 `addSystemReminder(buildPlanModeExitReminder(...))`。

### `src/agents/spawn.ts` / `src/teammate.ts`
**职责:** 子 agent / teammate 启动时也走 `buildSystemPrompt`。
**关键点:** 子 agent 可通过 `definition.systemPromptOverride` 跳过 builder,直接使用自定义 system prompt(适用于 explore/plan 等专用 agent)。

### `src/tools/descriptions.ts`(F5 双重强化)
**职责:** 集中放置所有工具的 description 字符串常量。
**关键点:**
- `BashDescription`:「IMPORTANT: Avoid using this tool to run cat, head, tail, sed, awk, or echo commands. Instead use the dedicated ReadFile, EditFile, or WriteFile tools which provide a better experience.」
- `EditFileDescription`:「You MUST read the file with ReadFile before editing. This tool will fail otherwise.」
- 各工具类(`BashTool / EditFileTool / ...`)在 `description = BashDescription` 处引用,保证工具 schema 中带上同一段强化文本。

## 模块交互

```
TUI/spawn/teammate ─初始化─→ detectEnvironment(workDir)
                          → buildSystemPrompt(env, opts?)
                          → createProvider(cfg, systemPrompt)
                                       │
                                       └─ AnthropicProvider(systemPrompt)
                                          OpenAIProvider(systemPrompt)
                                          OpenAIProvider(systemPrompt)

Agent.run() 每轮:
  ┌─ manageContext / 压缩
  ├─ if plan mode: conv.addSystemReminder(buildPlanModeReminder(...))
  ├─ if skills:    conv.addSystemReminder(buildActiveSkillsReminder(...))
  ├─ if hooks:     conv.addSystemReminder(note) × N
  └─ client.stream(apiConv, toolSchemas, signal)
         │
         └─→ StreamEvent { text_delta | thinking_* | tool_call_* | stream_end{usage{...,cacheRead,cacheCreation}} }
```

依赖方向(无环):`agent → { prompt, llm, conversation, tools, planfile }`;`llm → conversation(type only)`;`prompt → node:os / node:child_process`(纯标准库)。

## 文件组织

```text
qicode/
├── src/
│   ├── prompt/
│   │   ├── sections.ts          ─ 新/重写:8 个固定 Section 工厂 + Section 类型 + environmentSection
│   │   ├── builder.ts           ─ 新/重写:PromptBuilder、detectEnvironment、buildSystemPrompt
│   │   └── plan-mode.ts         ─ 新:buildPlanModeReminder / Exit / Reentry
│   ├── llm/
│   │   ├── events.ts            ─ 改:UsageInfo 加 cacheReadInputTokens / cacheCreationInputTokens
│   │   ├── client.ts            ─ 沿用:createProvider(cfg, systemPrompt) 工厂
│   │   ├── anthropic.ts         ─ 改:system 带 ephemeral 断点、tools/messages 末尾加 cache_control、解析 cache_* usage
│   │   └── openai.ts            ─ 改:system 置前缀、解析 cached_tokens、inputTokens 减除避免双计
│   ├── conversation/
│   │   └── conversation.ts      ─ 沿用:addSystemReminder 包 <system-reminder>;injectLongTermMemory 头插
│   ├── agent/
│   │   └── agent.ts             ─ 改:每轮 stream 前注入 plan-mode / skills / hooks reminder
│   ├── tools/
│   │   ├── descriptions.ts      ─ 改/沿用:Bash/EditFile/WriteFile 等 description 含双重强化语句
│   │   ├── bash.ts              ─ 沿用:description = BashDescription
│   │   └── edit-file.ts         ─ 沿用:description = EditFileDescription
│   ├── tui/
│   │   └── app.tsx              ─ 改:initClient 调 detectEnvironment + buildSystemPrompt
│   ├── agents/spawn.ts          ─ 改:子 agent 启动走 detectEnvironment + buildSystemPrompt(env)
│   └── teammate.ts              ─ 改:teammate 启动同上
└── tests/
    └── conversation.test.ts     ─ 已存在:断言 system-reminder 标签
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 系统提示组织 | Section 工厂 + PromptBuilder 类 + priority 排序 | F1 「挂载即扩展」;优先级数值化保证排序稳定(N1);函数返回值便于 unit test 单 Section |
| 环境信息归属 | 作为 priority=70 的固定 Section 嵌入 systemPrompt 字符串 | TS 实现把 systemPrompt 一次性传入 Provider 构造,运行时不再分块;同 client 实例的 systemPrompt 跨轮稳定即 N1 |
| Anthropic 缓存断点 | system 单 TextBlockParam 显式 `cache_control:{type:"ephemeral"}`、工具列表最后一个 tool 加 ephemeral、`markLastUserTailForCache` 给末条 user 末块加 ephemeral | 三层 ephemeral 断点形成「system → tools → history 前缀」嵌套命中;默认 TTL 5 分钟;SDK 类型上 cache_control 字段必须显式提供值,不能省略 |
| 工具是否单独打断点 | 是(末尾 tool 加 ephemeral) | TS 实现走 `(tools[last] as Record<string,unknown>).cache_control = {type:"ephemeral"}`,允许工具集变化时只前面部分命中(与 system 断点叠加复用) |
| OpenAI 环境信息 | 拼入 systemPrompt 字符串 → 单条 role=system 消息置于 Chat Completions messages 前缀 | 稳定前缀有利于支持缓存的端点，但不承诺所有兼容服务都提供 Prompt Cache。 |
| 缓存用量字段 | UsageInfo 加 cacheReadInputTokens / cacheCreationInputTokens | Anthropic 取 `event.message.usage.cache_read_input_tokens / cache_creation_input_tokens`;OpenAI Responses 取 `usage.input_tokens_details?.cached_tokens`;OpenAI Chat 取 `usage.prompt_tokens_details?.cached_tokens` |
| OpenAI inputTokens 减除 | `Math.max(0, (usage.input_tokens ?? 0) - cacheReadInputTokens)` | `input_tokens` 已含缓存命中部分;减除后 anchor 公式 `input + cache_read + cache_creation + output` 不双计 |
| Provider 接口签名 | 维持 `stream(request)`，systemPrompt 通过 `ChatRequest` 明确传入 | Provider 保持无隐藏会话状态，SubAgent 或模式切换可以安全构造每轮请求；reminder 仍走 conversation 通道。 |
| reminder 注入位置 | conversation.addSystemReminder → role=user + `<system-reminder>` 标签 → 写入持久 history | Anthropic / OpenAI 两协议都把它当普通 user 消息序列化;buildAnthropicMessages 已有连续 user 合并逻辑保证 N3 |
| reminder 是否持久 | 持久写入 history | plan-mode 是会话级状态,每轮重新调 addSystemReminder 累加;退出规划模式也通过新增 system-reminder 消息显式通知,而非清除历史 |
| 规划提醒节奏 | iteration===1 总完整;否则 floor((iter-1)/5) % 5 === 0 完整 | F7 首轮完整、间隔重复、其余精简;reminderInterval=5 内置常量 |
| 缓存验证呈现 | usage 字段透传到 anchor / debug,TUI 状态栏不展示 | 不动 UI;UsageInfo 携带字段供 `manageContext` 的 token anchor 与可选 debug 日志使用 |
| prompt ↔ llm 依赖 | systemPrompt 字符串在 createProvider 时注入 llm,llm 不 import prompt | 打破环依赖;prompt 只依赖 node 标准库,易于 unit test |
