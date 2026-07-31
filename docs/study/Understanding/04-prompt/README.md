# 04-Prompt 开发前认识与理解

> 本文用于第 04 章开发前学习。规划描述目标，当前代码决定真实起点；若两者冲突，以源码为准并在开发时校准任务。

## 一、为什么 Prompt 要单独拆成一章

前三章已经让 QiCode 能对话、调用工具并进行多轮 Agent Loop，但模型“怎么做事”仍主要依靠一段固定系统提示词。当前 `src/prompt/system-prompt.ts` 把身份、日期、工作目录和两段工具规则直接拼在一起。

这种写法在内容较少时够用，随着 Plan Mode、环境信息、工具规则和后续 Skill 增加，会出现三个问题：

1. 所有规则挤在一个字符串里，新增内容容易破坏原有顺序。
2. 固定规则和每轮变化的信息混在一起，不利于模型端提示缓存命中。
3. Agent 运行过程中需要补充提醒，但不应该不断修改整段系统提示词。

所以本章单独解决“怎样组织和传递模型指令”。它不增加新工具，也不重写 Agent Loop，而是在已有执行能力之上增加一层稳定、可扩展的提示词工程。

## 二、本章要完成什么

本章最终要形成三条清晰通道：

```text
固定规则 -> Section + PromptBuilder -> system prompt
环境信息 -> EnvironmentContext ------> system prompt 的环境段
运行提醒 -> <system-reminder> --------> conversation messages
```

具体目标是：

1. 把系统提示词拆成有名称、有优先级的 Section。
2. 由 `PromptBuilder` 统一排序、跳过空模块并组装最终文本。
3. 收集工作目录、平台、Git、模型和日期等必要环境信息。
4. 让稳定提示词在同一会话中保持不变，为 Provider 缓存创造条件。
5. 用 `<system-reminder>` 注入 Plan Mode 等运行时提醒，不把动态内容塞回固定提示词。
6. 解析 Anthropic 和 OpenAI 返回的缓存读取、缓存创建 token。
7. 在系统提示词和工具描述两处强调关键工具规则。

本章不实现 Skill、长期记忆、项目级自定义指令、完整权限确认和新的 Agent 能力；只预留可扩展位置。

## 三、用户实际经历的流程

用户在终端启动 QiCode 后，不会直接看到 PromptBuilder，但每一次回答都会受它影响：

```text
用户启动 QiCode
  |
  v
App 读取所选 Provider 和当前工作目录
  |
  v
detectEnvironment() 收集平台、Git、日期等信息
  |
  v
多个 Section 描述身份、任务、工具、风格和环境
  |
  v
PromptBuilder 按优先级组装 system prompt
  |
  v
Agent.run() 携带 system prompt、历史和工具定义请求 Provider
  |
  v
Provider 转成 Anthropic/OpenAI 请求并流式返回
  |
  v
若进入 Plan Mode，Agent 额外注入 <system-reminder>
  |
  v
模型遵循固定规则和本轮提醒完成任务
```

对用户来说，变化不是多了一个命令，而是模型更稳定地知道：自己是谁、在哪个目录、应该优先用什么工具、什么时候只能规划不能修改。

## 四、当前代码与目标的差距

当前代码已经存在：

- `src/prompt/system-prompt.ts`：用数组直接拼接固定提示词。
- `src/prompt/sections.ts`：T1 已完成，现已定义统一 `Section`、`EnvironmentContext` 和八个固定模块。
- `src/prompt/plan-mode.ts`：只有一份固定的最小 Plan Mode 提醒。
- `src/conversation/conversation.ts`：已经支持 `addSystemReminder()`。
- `src/agent/agent.ts`：Plan Mode 下会注入提醒，但还没有按轮次切换详略。
- Provider 当前通过每次 `stream()` 的请求参数接收 `systemPrompt`，规划中“Provider 构造器保存 systemPrompt”的描述已经过时，后续应按当前接口校准。

当前阶段只完成了“把提示内容变成统一 Section 数据结构”。下一步才会由 Builder 真正统一组装。

## 五、架构地图

```text
sections.ts
  定义每块提示内容与优先级
        |
        v
builder.ts
  排序、过滤、拼接 + 收集环境
        |
        v
TUI App
  创建本次会话使用的 system prompt
        |
        v
Agent.run()
  组合 system prompt、Conversation、tools
        |
        +-------------------+
        |                   |
        v                   v
Conversation          Provider
动态 reminder         协议请求与缓存用量
```

### 模块四问

| 模块 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
| --- | --- | --- | --- | --- |
| `Section` 工厂 | 分别描述身份、任务、工具、风格和环境 | `buildSystemPrompt()` | 不调用外部模块 | 避免所有规则挤在一个大字符串里 |
| `PromptBuilder` | 按优先级排序、跳过空内容、拼接提示词 | TUI 初始化流程 | Section 工厂 | 让新增模块不需要修改组装算法 |
| `detectEnvironment` | 收集当前运行环境的必要信息 | TUI 初始化流程 | Node.js OS、Git 命令 | 让模型知道当前目录和平台，同时失败可降级 |
| `Conversation` | 保存正式历史并承载 reminder 消息 | App、Agent | 消息数组 | 动态提醒需要进入请求，但不能混进稳定系统提示词 |
| `Agent` | 每轮决定注入哪些运行提醒并请求模型 | TUI App | Conversation、Provider | 提醒属于运行时编排，不属于界面或协议层 |
| `Provider` | 把统一请求转换为厂商协议并解析缓存用量 | Agent | Anthropic/OpenAI HTTP + SSE | 上层不应理解不同厂商的缓存字段 |

## 六、建议先掌握的 10 个问题

1. **系统提示词和用户消息有什么区别？**
   - 关键字：全局行为规则；优先级更高；不是用户本轮问题。
2. **为什么不能继续把所有规则写在一个字符串里？**
   - 关键字：职责混杂；顺序难维护；扩展容易冲突；无法独立测试。
3. **Section 的 `name`、`priority`、`content` 分别有什么用？**
   - 关键字：模块标识；装配顺序；真正发送的文本。
4. **为什么排序由 PromptBuilder 负责，而不是调用者手动排列？**
   - 关键字：统一规则；调用者不关心细节；新增模块只需挂载。
5. **环境信息为什么属于独立 Section？**
   - 关键字：内容来源不同；可降级；方便测试；与固定行为规则分离。
6. **什么叫“稳定提示词”？**
   - 关键字：同一会话跨轮逐字节不变；不要混入每轮变化的数据。
7. **为什么稳定内容有利于 Prompt Cache？**
   - 关键字：复用相同前缀；减少重复输入成本；降低首 token 延迟。
8. **`<system-reminder>` 为什么使用消息通道，而不是修改 system prompt？**
   - 关键字：运行时动态；按轮注入；不破坏稳定前缀。
9. **为什么关键工具规则要在提示词和工具描述中重复？**
   - 关键字：双重强化；全局决策时看提示词；选择工具时看 description。
10. **为什么缓存 token 要由 Provider 解析？**
    - 关键字：厂商字段不同；统一 UsageInfo；Agent 不依赖协议细节。

## 七、推荐学习顺序

1. 先读本文，能画出“固定提示、环境信息、动态提醒”三条通道。
2. 阅读 `docs/plan/04-prompt/spec.md` 的目标、边界和验收标准，不必一次记住全部字段。
3. 阅读 `src/prompt/sections.ts`，只回答每个 Section 在约束模型什么。
4. 下一阶段完成后再读 `PromptBuilder`，重点观察排序、跳空和拼接，不先钻进 Provider。
5. 接入 Agent 后，跟踪一次 `/plan` 请求中 reminder 如何进入 Conversation。
6. 最后再学习 Anthropic/OpenAI 缓存字段差异，因为它属于协议实现细节。

## 通过标准

你能不用看代码讲清楚：系统提示词为什么要拆模块、PromptBuilder 怎样组装、动态 reminder 为什么不放进稳定提示词，以及 Provider 缓存和 Agent Loop 各自负责什么。
