# 04-Prompt Interview 学习文档：用提示工程讲清 Agent 的上下文边界

> 本文基于第 04 章当前代码。类型检查已通过，但真实 Provider 缓存命中、完整自动化回归和性能收益尚未验证，面试时不要把协议接入描述成已获得确定的成本下降。

## 1. 30 秒项目介绍

```text
QiCode 是我用 TypeScript 实现的终端 Coding Agent。前三章完成了 Provider、工具调用和多轮 Agent Loop，第 04 章重点解决模型指令怎样稳定、可扩展地进入每轮请求。

我把系统提示拆成带优先级的 Section，由 PromptBuilder 统一排序和组装；启动时并行创建 Provider、探测工作目录、平台和 Git 信息，并在同一会话复用固定 systemPrompt。Plan Mode 等动态状态通过 system-reminder 写入 Conversation，不破坏稳定前缀。

协议层为 Anthropic 设置显式缓存断点，为 OpenAI 解析 cached_tokens；工具层同时用提示词、description 和执行校验落实专用工具优先与先读后改。
```

## 2. 两分钟讲法

```text
原实现把身份、目录和工具规则拼在一个字符串里。规则增加后会出现三个问题：模块顺序难维护，固定内容与动态状态混在一起，以及 Provider 缓存前缀不稳定。

我的方案分三层。第一层是 Section + PromptBuilder：每块规则有 name、priority、content，Builder 负责排序、去空和拼接。第二层是 runtime 初始化：detectEnvironment 获取平台、Shell、Git、日期，App 写入所选模型后只构建一次 systemPrompt，并通过 runtimeRef 跨用户回合复用。第三层是动态 reminder：Plan Mode 的完整、精简、退出和重入提醒写入 Conversation，而不是修改 systemPrompt。

Provider 层处理厂商差异。Anthropic 在 system、最后一个工具和最后一条 user 尾块设置 ephemeral；OpenAI 保持稳定 system 前缀并把 cached_tokens 从普通 input token 中扣除。安全规则不只写在提示词里：Plan Mode 会过滤工具并在执行前二次检查，EditFile 也要求当前 Agent 先成功读取目标文件。

当前边界是缓存协议已经接入，但还没有真实端点的命中率和延迟数据，所以我不会宣称已经证明成本下降。
```

## 3. 面试架构图

```text
Sections ---------> PromptBuilder -----------+
Environment ------> buildSystemPrompt()      |
                                             v
                                   AgentRuntime.systemPrompt
                                             |
User / Tool history -> Conversation --------+--> Provider
Plan state ---------> system-reminder -------+      |-- Anthropic cache_control
                                                    `-- OpenAI cached_tokens

ReadFile -> readFiles Set -> EditFile guard
```

讲图时强调：Builder 负责固定指令；Conversation 负责动态历史；Agent 负责何时注入；Provider 负责协议和缓存字段；工具执行层负责最终保护。

## 4. 高频问题

### Q1. 为什么不继续维护一个 system prompt 大字符串？

**关键词**：职责、顺序、扩展、独立测试。

```text
大字符串在内容少时简单，但规则增加后调用者必须记住拼接顺序，新增 Skill 或 Memory 也要修改核心函数。Section 把内容模块化，PromptBuilder 统一管理顺序、空内容和分隔符；新增模块只需提供 name、priority、content。
```

证据：[sections.ts](../../../../src/prompt/sections.ts:1)、[builder.ts](../../../../src/prompt/builder.ts:19)。

### Q2. priority 数字设计有什么取舍？

**关键词**：简单、可插入、隐式依赖。

```text
0、10、20 这样的间隔让新模块可以插入中间，不需要修改所有调用方。代价是顺序依赖没有类型系统保护，模块很多后需要集中维护优先级约定。当前规模下它比引入复杂依赖图更合适。
```

### Q3. 什么叫稳定 system prompt？

**关键词**：生命周期、逐字节一致、runtimeRef。

```text
稳定不只是 buildSystemPrompt 同样输入返回同样字符串，还要求同一会话不要反复采集环境和重建提示。App 初始化 AgentRuntime 后把 Promise 保存在 runtimeRef，后续用户回合都使用 runtime.systemPrompt，因此动态 Plan 状态不会改变固定前缀。
```

证据：[app.tsx](../../../../src/tui/app.tsx:54)、[app.tsx](../../../../src/tui/app.tsx:94)、[app.tsx](../../../../src/tui/app.tsx:201)。

### Q4. 为什么环境探测失败不能阻止 Agent 启动？

**关键词**：增强上下文、降级、超时。

```text
工作目录和平台是基础事实，Git 分支只是增强信息。detectEnvironment 给 Git 命令设置 2 秒上限并捕获错误；Git 不存在、目录不是仓库或命令失败时保留基础环境。否则一个非核心信息源会变成整个 Agent 的单点故障。
```

证据：[builder.ts](../../../../src/prompt/builder.ts:42)。

### Q5. 为什么 Plan Mode reminder 不放进 system prompt？

**关键词**：固定与动态、缓存前缀、历史可观察。

```text
Plan Mode 会进入、持续和退出，属于运行时状态。如果每轮修改 system prompt，稳定前缀会变化，也难以追踪模式何时生效。QiCode 将 reminder 包成 system-reminder 消息写入 Conversation，固定 systemPrompt 保持不变。
```

证据：[plan-mode.ts](../../../../src/prompt/plan-mode.ts:31)、[conversation.ts](../../../../src/conversation/conversation.ts:43)、[agent.ts](../../../../src/agent/agent.ts:54)。

### Q6. system-reminder 为什么仍是 user role，安全吗？

**关键词**：跨 Provider 统一、标签协议、不是安全边界。

```text
当前统一 Conversation 只有 user/assistant，并需要同时映射 Anthropic 和 OpenAI，所以动态 reminder 以带标签的 user 消息进入历史。系统提示会告诉模型标签语义，但它仍不是安全权限；Plan Mode 还必须过滤工具 schema，并在执行层用 PermissionChecker 拒绝写入和命令。
```

### Q7. Anthropic 和 OpenAI 的缓存实现有什么区别？

**关键词**：显式断点、稳定前缀、协议隔离。

```text
Anthropic 请求显式给 system、最后一个工具和最后一条 user 尾块设置 ephemeral cache_control。OpenAI 路径主要依赖相同 system/message 前缀，并从 usage.prompt_tokens_details.cached_tokens 读取缓存 token。Agent 最终只消费统一 UsageInfo，不理解厂商 JSON。
```

证据：[anthropic.ts](../../../../src/llm/anthropic.ts:153)、[openai.ts](../../../../src/llm/openai.ts:81)、[events.ts](../../../../src/llm/events.ts:7)。

### Q8. 为什么 OpenAI input token 要减去 cached token？

**关键词**：统一语义、避免双计、防御边界。

```text
prompt_tokens 通常包含缓存部分。如果同时把完整 prompt_tokens 记为普通输入、又单独记录 cached_tokens，上层汇总会重复计算。Provider 在协议边界将普通输入变为 max(0, promptTokens-cachedTokens)，并单独返回 cacheReadInputTokens。
```

### Q9. 为什么工具规则要写三层？

**关键词**：全局决策、局部选择、执行兜底。

```text
系统提示影响模型的全局策略，工具 description 在模型准备调用该工具时再次提醒，执行层处理模型仍然不遵守的情况。提示词可以提高正确率，但不能阻止真实写入；EditFile 的 readFiles 检查才是最终执行约束。
```

证据：[sections.ts](../../../../src/prompt/sections.ts:71)、[descriptions.ts](../../../../src/tools/descriptions.ts:1)、[edit-file.ts](../../../../src/tools/edit-file.ts:45)。

### Q10. 先读后改状态为什么放在 Agent，而不是全局变量？

**关键词**：会话隔离、生命周期、并发安全。

```text
已读取文件属于当前 Agent 任务的执行状态。放在 Agent 实例的 Set 中，可以让同一任务的多轮工具调用共享，同时避免不同会话互相继承读取资格。App 每个用户任务创建新 Agent，因此跨任务编辑会要求重新读取，这是偏安全的默认值。
```

### Q11. 如何证明缓存真的省钱？

**关键词**：不能只看代码、真实端点、对照实验。

```text
需要在同一会话发送至少两轮相同稳定前缀的请求，记录首轮 cacheCreationInputTokens、后续 cacheReadInputTokens、总输入成本和首 token 延迟，并与禁用缓存断点的对照组比较。当前只完成协议接入，还没有这组真实数据，所以不能宣称已经证明收益。
```

### Q12. 这套实现和 LangGraph 如何对应？

```text
PromptBuilder 相当于模型节点执行前的静态上下文构造；Conversation 是图状态；Plan reminder 是运行时状态注入；Provider 是模型适配节点；PermissionChecker 和 EditFile guard 类似节点执行前的策略中间件。自研这一层让我能解释框架替我处理了哪些状态与协议细节。
```

## 5. 深挖追问

| 追问 | 回答方向 |
| --- | --- |
| Section 同 priority 怎么办？ | JavaScript 稳定排序保留插入顺序，但最好避免依赖相同优先级。 |
| 环境日期为什么会过期？ | 它在 runtime 初始化时固定；长时间运行跨日不会刷新，这是稳定性与实时性的取舍。 |
| reminder 会不会越来越多？ | 会持久进入历史；后续 Context 章节需要压缩和历史管理。 |
| 为什么缓存字段可选？ | 流式 usage 可能分多事件到达，兼容端点也可能不返回缓存字段。 |
| 三个 Anthropic 断点是否总能命中？ | 不保证；还受模型、端点、最小缓存长度和前缀变化影响。 |
| EditFile guard 能否防路径别名？ | 当前按 resolve 后的绝对路径字符串比较，符号链接和不同别名仍是局限。 |
| Plan 文件由谁写？ | 当前只计算 `.QiCode/plan.md` 并检测存在性，没有专用写入流程。 |

## 6. 简历表达

```text
QiCode | TypeScript, Node.js, Ink, SSE
- 设计模块化系统提示架构，以 Section + priority + PromptBuilder 统一装配身份、任务、工具和环境上下文，并预留 Skill/Memory 扩展槽位。
- 将固定 systemPrompt 与动态 system-reminder 分离，在会话级复用 AgentRuntime，保持跨轮模型前缀稳定并支持 Plan Mode 状态注入。
- 在 Provider 层实现 Anthropic 显式 cache_control 断点与 OpenAI cached token 映射，向 Agent 暴露统一缓存用量字段。
- 构建提示词、工具 description、执行校验三层工具约束，并以会话内读取记录实现 EditFile 先读后改保护。
```

不要写：

- “缓存成本降低了 X%”——目前没有真实数据。
- “实现生产级权限沙箱”——当前没有完整路径沙箱和交互式授权。
- “完成 Skill/Memory”——目前只有 Builder 槽位。

## 7. 推荐学习顺序

1. 先读 [Debug 文档](../../study/Debug/04-prompt/README.md) 的架构图和断点路线。
2. 阅读 [sections.ts](../../../../src/prompt/sections.ts:1) 和 [builder.ts](../../../../src/prompt/builder.ts:19)。
3. 沿 [app.tsx](../../../../src/tui/app.tsx:54) 追踪 runtime 初始化。
4. 沿 [agent.ts](../../../../src/agent/agent.ts:54) 追踪 reminder 注入。
5. 最后比较 [anthropic.ts](../../../../src/llm/anthropic.ts:153) 与 [openai.ts](../../../../src/llm/openai.ts:81)。
6. 脱稿回答 Q3、Q5、Q7、Q9、Q11。

## 8. 独立练习

给 `PromptBuilder.add()` 增加重复 Section name 检测策略，并自己选择“覆盖、拒绝或允许重复”之一。

完成后 Review：

- 策略是否改变现有八个固定 Section？
- 同名但不同 priority 应该怎样处理？
- 错误应在 add 阶段还是 build 阶段抛出？
- 这个复杂度是否真的值得加入当前项目？
