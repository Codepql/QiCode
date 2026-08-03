# 01-LLM Debug 学习文档：从架构地图到亲手调试

> 适用代码：QiCode 第一章当前实现。
>
> 核心目标不是把功能做完，而是在开发过程中理解真实架构和运行逻辑：知道功能用什么实现、代码为什么这样组织、出问题去哪里定位，以及别人追问时如何用代码证据回答。

## 1. 本章实际完成了什么

本章只根据当前仓库已经存在的代码学习以下能力：

- 从 YAML 加载并校验 Provider 配置。
- 在 Ink TUI 中选择 Provider、输入问题并展示结果。
- 通过统一 Provider 接口调用 Anthropic 或 OpenAI 协议。
- 用 SSE 逐段解析并显示模型回复。
- 在当前进程保存历史，实现多轮对话。
- 保存但不展示 Anthropic extended thinking。
- 处理超时、取消、协议错误和网络错误。

这里不推演后续模块，也不使用示例项目的 Planner、Tool Executor 等结构。下面每张图都能在当前 `src/` 中找到对应文件和调用关系。

## 2. 架构地图

### 2.1 启动流程

```text
pnpm dev
  |
  v
src/main.tsx
  |-- 解析 --config
  |-- 决定配置文件路径
  |-- loadConfig() 读取并校验 YAML
  v
Ink render(<App />)
  |
  |-- 单 Provider：直接进入对话
  `-- 多 Provider：ProviderSelect 选择后进入对话
```

### 2.2 一次用户请求的主流程

```text
InputBox
  | onSubmit(text)
  v
App.submit()
  |
  |-- 1. Conversation.addUserMessage()
  |-- 2. buildSystemPrompt()
  |-- 3. provider.stream(ChatRequest)
  |        |
  |        |-- AnthropicProvider 或 OpenAIProvider
  |        |-- buildProviderUrl()
  |        |-- fetch()
  |        |-- assertSuccessfulResponse()
  |        |-- parseSSE()：字节流 -> SSEMessage
  |        `-- 协议字段 -> 统一 StreamEvent
  |
  |-- 4. 消费 StreamEvent，更新界面临时状态
  |-- 5. Conversation.addAssistantMessage()
  `-- 6. 清理请求状态
           |
           v
ChatView / Activity / StatusBar / InputBox 重新渲染
```

这里不是抽象示例，而是当前 `App.submit()` 的真实执行顺序。先理解这条主链，再打开源码；任何核心文件都应该能放回这张图中。

## 3. 模块地图：阅读每个文件时只问四个问题

四问是：

1. 这个文件负责什么？
2. 谁调用它？
3. 它调用谁？
4. 为什么需要它？

### 3.1 启动与配置层

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
|---|---|---|---|---|
| `src/main.tsx` | CLI 入口、配置路径解析、启动 Ink | Node/tsx | `loadConfig`、`render(App)` | 把命令行世界和应用世界连接起来 |
| `src/config/types.ts` | 定义配置的统一形状 | 配置层、Provider、TUI | 无 | 让所有模块对配置字段达成一致 |
| `src/config/load-config.ts` | 查找、读取、解析、校验 YAML 和环境变量 | `main.tsx` | 文件系统、`js-yaml` | 尽早阻止错误配置进入运行时，并避免泄露 Key |

### 3.2 会话与提示词层

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
|---|---|---|---|---|
| `src/conversation/types.ts` | 定义 user/assistant、text/thinking 消息块 | Conversation、Provider、TUI | 无 | Anthropic thinking 和普通文本需要统一历史模型 |
| `src/conversation/conversation.ts` | 追加、复制和读取当前进程内历史 | `App`、`ChatView` | 会话类型 | 多轮对话不能只保存界面字符串 |
| `src/prompt/system-prompt.ts` | 生成最小系统提示词 | `App.submit()` | 日期和工作目录 | 集中管理模型身份与运行环境信息 |

### 3.3 Provider 与网络层

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
|---|---|---|---|---|
| `src/llm/events.ts` | 定义 `StreamEvent`、`UsageInfo` 和工具契约 | Agent 和所有 Provider | 无 | 建立协议无关的事件语言 |
| `src/llm/client.ts` | 定义 Provider 请求契约、创建协议实现并提供共享网络能力 | `App`、两种 Provider | Anthropic/OpenAI Provider、Web Stream、URL | 上层不写协议判断，共享错误、HTTP、URL 与 SSE 语义 |
| `src/llm/anthropic.ts` | 组装 Anthropic 请求并映射流事件 | Provider 工厂 | fetch、HTTP、URL、SSE | 隔离 Anthropic 格式和 extended thinking |
| `src/llm/openai.ts` | 组装 OpenAI 兼容请求并映射流事件 | Provider 工厂 | fetch、HTTP、URL、SSE | 隔离 Chat Completions 格式和兼容端点差异 |

### 3.4 TUI 层

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
|---|---|---|---|---|
| `src/tui/app.tsx` | 顶层状态机，编排完整一轮对话 | `main.tsx` | Conversation、Provider、所有 TUI 子组件 | 它是流程协调者，不承担协议解析细节 |
| `src/tui/input-box.tsx` | 编辑文本、光标移动、Enter 提交 | `App` | Ink 输入事件 | 将键盘细节与业务提交逻辑分开 |
| `src/tui/chat-view.tsx` | 展示历史、流式文本和完成后的 Markdown | `App` | Conversation、sanitize、marked | 区分“生成中纯文本”和“完成后格式化文本” |
| `src/tui/provider-select.tsx` | 多配置时选择 Provider | `App` | Ink 输入事件 | Provider 选择只属于启动交互 |
| `src/tui/activity.tsx` | Spinner 和耗时 | `App` | 定时器 | 让用户知道请求仍在进行 |
| `src/tui/status-bar.tsx` | 展示协议、模型和 token | `App` | 无 | 集中展示本轮运行状态 |
| `src/tui/header.tsx` | 展示猫头、版本、模型和目录 | `App` | Ink 布局 | 品牌信息与业务流程分离 |
| `src/tui/sanitize-terminal.ts` | 删除危险终端控制序列 | InputBox、ChatView | 正则替换 | 模型输出和用户输入都属于不可信文本 |

## 4. 一次请求到底如何实现

### 4.1 输入进入状态机

入口在 `src/tui/input-box.tsx` 的 `InputBox`。Enter 后调用 `onSubmit`，真正的业务逻辑在 `src/tui/app.tsx` 的 `submit()`。

`submit()` 首先做四件事：

1. 拒绝并发提交，保证同一时间只有一个请求。
2. 处理 `/exit`。
3. 将用户消息加入 `Conversation`。
4. 清空上一轮动态状态并进入 `waiting`。

这里的关键设计是：**React state 用来渲染，Conversation 用来保存可发送给模型的真实历史。** 两者用途不同，不要把它们理解成无意义的重复。

### 4.2 上层只调用统一 Provider

`App` 不判断 Anthropic 和 OpenAI 的 SSE JSON。它只调用：

```ts
for await (const event of provider.stream(request)) {
  // 只处理统一 StreamEvent
}
```

协议差异被限制在 `src/llm/anthropic.ts` 和 `src/llm/openai.ts`。以后增加新协议时，理想情况是增加 Provider 实现并扩展工厂，而不是重写 TUI 对话流程。

### 4.3 为什么 SSE 要分成两层

```text
网络字节 chunk
  -> parseSSE()
  -> { event?, data }
  -> Anthropic/OpenAI Provider
  -> StreamEvent
  -> App
```

`parseSSE()` 只理解 SSE 语法，不理解模型协议。Provider 理解供应商 JSON，但不处理字节拆包。这是两个不同变化原因，所以必须拆开。

例如，一个 JSON 事件可能被网络拆成三次到达，也可能三个事件一次到达。直接对每个 chunk 执行 `JSON.parse()` 会随机失败。

### 4.4 多轮对话如何“记住”历史

多轮记忆不是模型自动记住，而是 QiCode 每轮重新发送历史：

```text
第一轮请求：[用户消息 1]
第一轮完成：[用户消息 1, 助手消息 1]
第二轮请求：[用户消息 1, 助手消息 1, 用户消息 2]
```

`Conversation.getMessages()` 返回深复制，防止调用方意外修改内部历史。退出进程后历史消失，本章没有持久化记忆。

### 4.5 Extended thinking 为什么隐藏但必须保存

Anthropic thinking 有两个不同要求：

- 不能在 TUI 中当成最终答案展示。
- thinking 和 signature 要保存在助手历史中，下一轮按协议发回。

因此会话内容不是单个字符串，而是 `text` 与隐藏的 `thinking` block。OpenAI Provider 会过滤 thinking，只发送可见文本；Anthropic Provider 会恢复完整 block。

### 4.6 错误、超时和取消如何汇合

`App` 为每轮创建 `AbortController`：

- 请求超时：定时器调用 `abort()`。
- 第一次 Ctrl+C：调用 `abort()`，取消当前请求。
- 组件卸载：清理尚未结束的请求。

网络层把底层异常转换为统一错误，App 再转换为安全、可理解的提示。即使中途已经收到部分正文，`commitAssistant()` 仍会保存它，然后允许用户继续下一轮。

## 5. 推荐阅读顺序

不要按文件夹字母顺序读。按一条请求的因果顺序读：

1. `src/llm/events.ts`：先认识系统边界和事件语言。
2. `src/conversation/types.ts`：理解模型历史的数据形状。
3. `src/tui/app.tsx`：只看 `submit()` 和 `commitAssistant()`。
4. `src/llm/client.ts`：看上层怎样得到具体实现。
5. `src/llm/openai.ts`：先学较简单的文本流映射。
6. `src/llm/client.ts`：理解 chunk、frame 和 event 的区别。
7. `src/llm/anthropic.ts`：最后增加 thinking 和 signature。
8. `src/conversation/conversation.ts`：验证历史如何保存和复制。
9. `src/llm/client.ts`：理解失败路径。
10. 其余 TUI 与配置文件：补齐启动和展示细节。

第一次阅读只回答四问；第二次才跟进函数内部；第三次通过断点验证自己的理解。

## 6. 核心断点路线

建议使用 VS Code JavaScript Debug Terminal 启动 `pnpm dev`，或为 `tsx src/main.tsx` 建立调试配置。

### D1. 配置进入应用

- 断点：`src/main.tsx` 调用 `loadConfig` 和 `render` 的位置。
- 观察：`configPath`、`config.providers.length`。
- 要证明：配置只在启动阶段加载，App 接收的是已经校验的对象。

### D2. 用户消息进入历史

- 断点：`src/tui/app.tsx` 的 `submit()` 开头和 `addUserMessage()` 后。
- 观察：`rawText`、`busy`、`conversationRef.current.getMessages()`、`status`。
- 要证明：用户消息先进入历史，然后才发起网络请求。

### D3. Provider 抽象发生作用

- 断点：`src/llm/client.ts` 的 `createProvider()`。
- 观察：`config.protocol`、返回实例类型。
- 要证明：App 不直接依赖具体 Provider 类。

### D4. 请求体和完整历史

- 断点：`src/llm/openai.ts` 或 `src/llm/anthropic.ts` 调用 `fetchImpl` 前。
- 观察：URL、headers、序列化后的 messages；不要在截图或笔记中保存真实 API Key。
- 要证明：第二轮请求确实重新携带第一轮历史。

### D5. 字节流变成 SSE 事件

- 断点：`src/llm/client.ts` 的 `buffer += ...`、`findEventBoundary()` 和 `yield message` 附近。
- 观察：`result.value`、`buffer`、`boundary`、`frame`、`message.data`。
- 要证明：chunk 边界与事件边界不是一回事。

### D6. 协议事件变成统一事件

- 断点：具体 Provider 的 `for await (const message of parseSSE(...))` 内。
- 观察：原始 `message.data` 和即将 yield 的 `StreamEvent`。
- 要证明：供应商差异在 Provider 内结束。

### D7. 流式更新和最终提交

- 断点：`src/tui/app.tsx` 消费 `text_delta` 的分支，以及 `commitAssistant()`。
- 观察：`event`、`text`、`streamingText`、`thinking`、`signature`、最终 `content`。
- 要证明：流式字符串用于即时展示，完成后才成为正式历史。

## 7. 亲手制造错误

每个实验都要做四件事：先预测现象，再制造错误，再沿断点找原因，最后恢复修改。不要提交真实 Key或故障代码。

### 实验 1：配置字段错误

- 制造：把本地 YAML 的 `protocol` 改成不存在的值，或删除 `model`。
- 断点：`load-config.ts` 的字段校验函数。
- 观察：错误是否在网络请求前发生，提示是否指出字段且不包含 Key。
- 对应面试题：为什么需要独立配置层？怎样保护密钥？

### 实验 2：证明 chunk 不等于事件

- 制造：在 SSE 测试中把一条包含中文的事件拆成多个极小 `Uint8Array` chunk。
- 断点：`parseSSE()` 的解码和 boundary 查找。
- 观察：前几个 chunk 不能产出事件，直到空行边界完整才 yield。
- 对应面试题：SSE 如何处理拆包、粘包和 UTF-8 跨 chunk？

### 实验 3：Provider 返回非法 JSON

- 制造：让本地 fake stream 发送 `data: {not-json}`。
- 断点：具体 Provider 的 `parseJsonRecord()`。
- 观察：错误如何成为 `ProviderResponseError`，再如何显示为安全提示。
- 对应面试题：协议错误如何与网络错误区分？

### 实验 4：模拟 401 和 429

- 制造：fake fetch 分别返回 401、429，并为 429 添加 `retry-after`。
- 断点：`assertSuccessfulResponse()`。
- 观察：错误类型、`retryAfterSeconds` 和最终用户文案。
- 对应面试题：为什么不把原始响应体直接显示给用户？

### 实验 5：流式中途断开

- 制造：先发送两个 `text_delta`，随后让流抛出异常。
- 断点：`App.submit()` 的 `catch` 和 `commitAssistant()`。
- 观察：部分 `text` 是否保存、输入框是否重新启用。
- 对应面试题：流式失败怎样保证可恢复性？

### 实验 6：验证多轮历史

- 制造：完成第一轮，在第二轮 Provider 请求前暂停。
- 断点：Provider 调用 fetch 前。
- 观察：messages 是否包含 user1、assistant1、user2，顺序是否正确。
- 对应面试题：LLM 为什么能“记住”上一轮？

### 实验 7：验证 thinking 隐藏与保留

- 制造：fake Anthropic stream 发送 thinking、signature 和 text。
- 断点：`thinking_complete` 分支、`commitAssistant()`、下一轮 Anthropic 请求映射。
- 观察：TUI 只出现 text；Conversation 同时存在 thinking；下一轮请求带回 signature。
- 对应面试题：extended thinking 最难的状态管理是什么？

### 实验 8：取消和超时

- 制造：让 fake Provider 永不主动完成；分别触发 Ctrl+C 和缩短 `requestTimeoutMs`。
- 断点：AbortController 创建处、timeout 回调、`normalizeFetchError()`。
- 观察：两条路径都 abort，但界面提示不同，finally 会清理计时器和引用。
- 对应面试题：取消、超时和网络失败如何统一又如何区分？

### 实验 9：终端控制字符注入

- 制造：向 `sanitizeTerminalText()` 传入 ANSI 清屏、改标题或移动光标序列。
- 断点：`sanitize-terminal.ts`。
- 观察：危险序列被删除，普通中文、换行仍保留。
- 对应面试题：为什么聊天文本也属于不可信输入？

## 8. 学习、排错和面试共用的回答模板

遇到任何文件或模块问题，按下面顺序回答：

```text
定位：它处于哪一层、主链的哪个位置。
职责：它接收什么，输出什么，只负责什么。
调用：谁调用它，它又调用谁。
原因：如果没有这一层，会出现什么耦合或错误。
证据：指出真实函数、断点和观察到的变量。
权衡：当前实现解决了什么，还没有解决什么。
```

示例：

```text
SSE 解析器位于 Provider 的网络流和协议映射之间。
它接收字节流，输出 event/data，不理解 Anthropic 或 OpenAI JSON。
两个 Provider 都调用它，它调用 Web Stream reader 和 TextDecoder。
单独拆分是因为网络 chunk 与 SSE 事件边界不一致，而且两家协议都需要这套能力。
我通过把一个中文事件拆成单字节 chunk，在 buffer 和 boundary 处断点验证过。
当前实现支持流式解析和大小限制，但还没有自动重连。
```

## 9. 学习完成标准

你不需要默写代码。能完成以下事情，就算掌握本章：

- 不看源码画出启动链和一次请求链。
- 随机指出一个核心文件，用四问解释它。
- 解释为什么 Provider、SSE、Conversation 必须分层。
- 用断点证明第二轮包含第一轮历史。
- 完成至少 5 个故障实验，并记录“预测、现象、原因、修复”。
- 能用 1 分钟解释 extended thinking 的隐藏、保存和回传。
- 遇到“为什么这样实现”的追问，能给出代码位置、运行现象和设计原因，而不是只背概念。
