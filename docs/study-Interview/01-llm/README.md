# 01-LLM Interview 学习文档：用真实代码讲清 QiCode

> 本文不是脱离代码的背诵题库。每个问题都来自当前实现，并对应 `docs/study/Debug/01-llm/README.md` 中可以亲手验证的调用链、断点或故障实验。
>
> 学习目标：开发时知道为什么这样写，出问题时知道沿哪条链定位，面试时能用真实实现和调试证据回答。

## 1. 30 秒项目介绍

```text
QiCode 是我用 TypeScript 开发的终端 AI 助手，目前实现了配置加载、TUI 对话和 LLM 流式通信。
它通过统一 Provider 接口支持 Anthropic 和 OpenAI 兼容协议，使用原生 fetch 和 SSE 实现流式输出，
并在进程内维护多轮上下文。Anthropic 模式还支持 extended thinking：思考内容不展示，
但会连同 signature 保存在历史中供下一轮使用。界面使用 Ink 构建，支持取消、超时、错误分类和流式中断恢复。
```

这段介绍只讲当前代码中能够展示和调试证明的内容：做了什么、怎样分层、核心难点和可靠性处理。

## 2. 先画架构，再聊代码

面试官问“项目架构是什么”，先画这一张：

```text
Node / tsx
    |
    v
main.tsx
    |-- resolveConfigPath() -> loadConfig() -> YAML / 环境变量
    `-- render(<App />)
                |
                |-- InputBox / ProviderSelect 接收输入
                |-- Conversation 保存正式历史
                |-- buildSystemPrompt() 生成系统提示词
                |-- createProvider() 创建协议实现
                |       |-- AnthropicProvider
                |       `-- OpenAIProvider
                |              |
                |              |-- URL + HTTP 公共处理
                |              `-- parseSSE()
                |                     |
                |                     v
                |                   LLM API
                |
                `-- ChatView / Activity / StatusBar 展示状态
```

这张图对应当前真实代码：`App` 是编排中心，Conversation 与 Provider 不是简单上下级关系，而是由 `App.submit()` 按顺序协调。TUI 只理解统一的 `StreamEvent`，供应商差异停留在 Provider 内，SSE 只解析事件格式。

## 3. 高频问题与回答

### Q1. 为什么这个项目要分这么多模块？是不是过度设计？

**回答关键词**：变化原因、职责边界、可替换、可测试。

参考回答：

```text
不是按文件数量拆分，而是按变化原因拆分。配置会因部署方式变化，TUI 会因交互变化，
Provider 会因供应商协议变化，SSE 会因流式传输边界变化，会话则负责历史一致性。
如果全部写在 App 中，增加新 Provider 或修改界面都会碰到同一段代码，也很难单独模拟网络流。
当前核心依赖方向是 App -> Provider 接口 -> 协议实现 -> 通用 SSE，反向不依赖 Ink。
```

代码证据：`src/tui/app.tsx`、`src/providers/types.ts`、`src/providers/sse.ts`。

Debug 证据：架构地图、D3、D5。

### Q2. Provider 抽象解决了什么问题？

**回答关键词**：统一输入、统一事件、适配器、开闭原则。

参考回答：

```text
两家 API 的请求体、Header 和流事件都不同。如果让 App 直接处理这些差异，TUI 会出现大量 protocol 判断。
我定义 Provider.stream(ChatRequest)，并统一输出 text_delta、thinking、usage 和 done 等 StreamEvent。
Anthropic 和 OpenAI 各自负责协议映射，App 只消费统一事件。
这样新增协议主要增加一个适配器并扩展工厂，不需要重写主对话状态机。
```

代码证据：`src/providers/types.ts`、`src/providers/create-provider.ts`、两个 Provider 实现。

追问“新增 Gemini 改哪里”：增加 Gemini Provider、扩展配置协议和工厂；若统一事件已足够，Conversation 和主要 TUI 流程不改。

### Q3. 为什么不用官方 SDK，而使用原生 fetch？

**回答关键词**：首期范围、统一流处理、依赖成本、权衡。

参考回答：

```text
第一阶段只需要两家的文本流式接口。Node 22 已有 fetch、Web Streams 和 AbortController，
直接实现可以让两家共享 SSE、错误分类和取消路径，也能更清楚地学习协议。
代价是请求类型和事件映射要自己维护，协议升级时需要跟进。项目复杂后，如果 SDK 能明显降低维护成本，
我会保留 Provider 接口，只替换 Provider 内部实现，而不是让 SDK 类型泄漏到上层。
```

不要回答“SDK 不好”。这是当前阶段的工程权衡，不是永久结论。

### Q4. SSE 流式输出是怎么实现的？

**回答关键词**：AsyncGenerator、TextDecoder、buffer、空行边界、拆包粘包、即时 yield。

参考回答：

```text
fetch 返回 ReadableStream<Uint8Array>。parseSSE 使用流式 TextDecoder 解码，把文本累积到 buffer，
按 SSE 的空行分隔找到完整 frame，再解析 event 和多个 data 行并 yield。
Provider 对 data 做 JSON 解析并映射为统一 StreamEvent，App 用 for await 消费 text_delta，
每收到一段就更新 React state，所以不是等待完整答案后再渲染。
```

追问“为什么不能每个 chunk 直接 JSON.parse”：chunk 是传输分块，不保证与 UTF-8 字符、JSON 或 SSE 事件边界对齐；还可能一个 chunk 包含多个事件。

追问“如何避免内存无限增长”：解析器限制 buffer、单事件和单行大小，请求层还提供超时和取消。

Debug 证据：D5、实验 2。

### Q5. 多轮对话是怎么实现的？模型真的记住了吗？

**回答关键词**：客户端重发历史、顺序、进程内、深复制、无持久化。

参考回答：

```text
模型 API 本身不会自动记住这个本地会话。QiCode 用 Conversation 按顺序保存 user 和 assistant 消息，
每次请求都重新发送完整历史。第一轮完成后历史是 user1、assistant1，第二轮提交后发送
user1、assistant1、user2。getMessages 返回复制，避免外部代码意外修改内部历史。
当前历史只在进程内，退出后清空，还没有做持久化和上下文压缩。
```

追问“历史越来越长怎么办”：后续需要 token 预算、裁剪、摘要或上下文压缩；当前阶段会由 Provider 返回上下文过长错误。

Debug 证据：D2、D4、实验 6。

### Q6. Claude extended thinking 最难的地方是什么？

**回答关键词**：隐藏展示、完整保存、signature、跨轮回传、协议隔离。

参考回答：

```text
难点不是收到 thinking 文本，而是展示状态和协议历史的要求不同。用户界面只能展示最终 text，
但 Anthropic 下一轮需要此前 thinking block 和 signature。因此 Conversation 使用 block 结构保存隐藏 thinking，
App 分别累积 thinking、signature 和 text，ChatView 只读取 visibleText。
下一轮 Anthropic Provider 恢复完整 block，OpenAI Provider 则过滤 thinking，只发送文本。
```

追问“为什么不能把 thinking 拼进 assistant 文本”：会泄露不应展示的内容，也破坏 Anthropic 要求的结构化 block 和 signature。

Debug 证据：D7、实验 7。

### Q7. Anthropic 和 OpenAI 的差异被放在哪里？

**回答关键词**：请求适配、响应适配、共同基础设施。

参考回答：

```text
差异集中在各自 Provider：URL 资源、认证 Header、请求 messages 结构、thinking 参数和供应商事件字段。
共同部分包括 Provider 契约、Conversation 类型、URL 拼接、HTTP 错误处理和 SSE 字节流解析。
这样既没有强行把两家协议做成完全一样，也没有把差异扩散到 TUI。
```

追问“OpenAI 兼容服务为什么没有第三种 protocol”：兼容服务仍使用 OpenAI 消息协议，通过 `protocol: openai` 和不同 `base_url` 表达，避免制造没有行为差异的新类型。

### Q8. App 为什么既有 React state，又有 Conversation？

**回答关键词**：渲染状态、领域状态、流式临时态、正式历史。

参考回答：

```text
React state 服务于界面渲染，例如 waiting、streamingText、token 和错误提示；Conversation 保存要发送给模型的正式历史。
流式生成中的 text 是临时状态，完成或失败后才通过 commitAssistant 写入 Conversation。
这种区分避免未完成消息被重复加入历史，也让中断时可以明确决定是否保留部分结果。
```

追问“这是唯一方案吗”：不是，也可以用 reducer 统一状态；当前实现规模较小，用 Conversation 加局部 React state 更直观。复杂度继续增长时应考虑显式 reducer 或状态机。

Debug 证据：D2、D7、实验 5。

### Q9. 请求失败后为什么程序还能继续使用？

**回答关键词**：错误边界、统一分类、finally 清理、部分结果、状态恢复。

参考回答：

```text
启动配置错误会阻止应用启动，但单轮 Provider 错误只结束当前请求。
HTTP 和 fetch 异常先被转换为 authentication、rate limit、context too long、network、invalid response 或 aborted，
App catch 后保存已经收到的部分正文，设置安全错误提示，并把状态改为 failed。
finally 清理 timeout、AbortController 和 streamingText，所以输入可以重新启用，不需要重启进程。
```

追问“为什么不显示原始错误体”：其中可能包含敏感请求信息、供应商内部细节或终端控制字符；用户只需要可行动的分类提示。

Debug 证据：实验 3、4、5。

### Q10. Ctrl+C、超时和网络中断有什么区别？

**回答关键词**：AbortController、共同取消机制、不同触发原因、清理。

参考回答：

```text
Ctrl+C 和超时最终都通过同一个 AbortController 中止 fetch 和 SSE 读取，因此底层清理路径统一。
区别在触发原因和用户提示：App 用 timedOut 标记区分超时；第一次 Ctrl+C 取消请求并提示二次确认，
短时间内第二次才退出。网络中断不是主动 abort，会被归类为 NetworkError。
三条路径最后都会进入 finally 清理定时器和请求引用。
```

Debug 证据：实验 8。

### Q11. 配置和 API Key 如何保证安全？

**回答关键词**：启动校验、环境变量引用、最小错误、脱敏、不提交真实配置。

参考回答：

```text
配置层在启动时校验固定字段、协议、URL、重复名称和 thinking 约束，API Key 可以写成环境变量引用。
运行时错误不会打印原始 YAML、请求 Header 或完整响应体，用户提示经过统一格式化和已知 secret 脱敏。
真实配置目录不应提交版本库，示例配置只保留占位符。
```

追问“内存里有没有 Key”：发请求时仍必须存在解析后的 Key，所以这里不是零暴露；目标是减少日志、异常、截图和版本库泄露面。

Debug 证据：实验 1、4。

### Q12. 为什么要清理终端控制字符？

**回答关键词**：不可信输出、ANSI/OSC、终端注入、显示边界。

参考回答：

```text
LLM 输出和用户输入都可能包含 ANSI 或 OSC 控制序列，它们不只是颜色，还可能清屏、移动光标、修改终端标题，
从而伪造界面状态。QiCode 在进入终端渲染前删除危险控制字符，同时保留普通文本和换行。
这相当于 Web 界面的输出编码：不能因为内容来自模型就默认可信。
```

Debug 证据：实验 9。

### Q13. 当前实现还有哪些不足？

**回答关键词**：诚实、边界、演进计划。

参考回答：

```text
当前历史只在内存中，长对话没有 token 预算和压缩；Provider 没有自动重试和断线重连；
状态复杂度继续增长后 App 需要更明确的 reducer 或状态机；真实跨平台终端和两家 Provider 还需要最终端到端验收；
真实跨平台终端和两家 Provider 还需要最终端到端验收。
这些是我从当前实现和验收状态中能够确认的限制，不会把规划中的能力说成已经完成。
```

优秀回答不是“项目没有问题”，而是能说明限制、影响和下一步。

## 4. 面试官让你讲一个最难问题

优先讲 SSE 或 extended thinking，不要只讲 UI 样式。

### STAR 示例：SSE 拆包问题

```text
背景：两家模型都要在终端逐步显示答案，但 HTTP chunk 边界不稳定。
任务：实现一个两家 Provider 都能复用、可取消、不会因拆包随机失败的流解析器。
行动：把解析分为字节流到 SSE、SSE 到协议事件两层；使用流式 TextDecoder 和 buffer，
按空行找完整 frame，支持多 data 行、CRLF、UTF-8 跨 chunk，并增加大小限制。
结果：上层 Provider 可以稳定消费 SSEMessage，App 只处理统一 StreamEvent。
验证：我把中文事件拆成极小 chunk，在 buffer、boundary 和 yield 位置断点，证明输出与 chunk 划分无关。
```

### STAR 示例：thinking 跨轮状态

```text
背景：Claude 的 thinking 不能展示，但后续请求需要保存并回传 thinking 和 signature。
任务：同时满足界面隐藏和协议历史完整。
行动：把 Conversation 从字符串升级为 text/thinking block；App 分开累积三类数据，
ChatView 只读取 visibleText，Anthropic 恢复完整 block，OpenAI 过滤 hidden block。
结果：界面只显示最终回答，两种 Provider 仍共享同一个 Conversation 模型。
验证：用 fake stream 发送 thinking、signature 和 text，在本轮提交和下一轮请求体设置断点检查。
```

## 5. 简历写法

当前阶段可以写成：

```text
QiCode - TypeScript 终端 AI 助手
- 基于 Ink/React 构建交互式 TUI，支持流式响应、多轮上下文、请求取消、超时和错误恢复。
- 设计统一 Provider 适配层，以原生 fetch + SSE 接入 Anthropic 与 OpenAI 兼容协议，隔离供应商请求和事件差异。
- 实现 Claude extended thinking 的隐藏存储与跨轮 signature 回传，并对终端控制字符和敏感错误信息进行安全处理。
```

简历只写当前代码能够运行、调试和解释的能力，不把规划内容当成已完成成果。

## 6. 面试前自测

如果下面任何一题答不出来，回到 Debug 文档做对应实验：

- 60 秒画出一次请求的完整链路。
- 随机选择一个文件回答“负责什么、谁调用、调用谁、为什么需要”。
- 不使用“为了扩展性”这一句空话，具体解释 Provider 抽象减少了哪些修改。
- 用 chunk 与 event 的区别解释 SSE，而不是只说“服务器推送”。
- 画出第二轮请求携带的消息顺序。
- 解释 thinking 为什么不能只保存在 streamingText。
- 解释中途失败时部分回复在哪里被保留。
- 说明 Ctrl+C、timeout、network error 的共同点和区别。
- 说出当前项目至少三个真实不足。
- 能把架构图中的每个节点对应到当前真实文件和函数。

## 7. 最有效的学习方式

按同一个问题完成四次输出：

```text
第 1 次：看架构图，用自己的话口述。
第 2 次：打开对应文件，用四问定位。
第 3 次：设置断点或制造错误，拿到运行证据。
第 4 次：关闭文档，按“设计 -> 实现 -> 验证 -> 权衡”回答面试题。
```

不要背整篇答案。只记关键词和真实调试证据，回答才会像你做过这个项目，而不是背过一个项目。
