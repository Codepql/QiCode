# 01-LLM 开发前认识与理解

> 本文用于阅读 `spec.md` 和 `plan.md` 后检查理解，不代替原始规划文档。
>
> 当前阶段只学习和确认理解，不编写源码。

## 阅读范围

开发前先阅读：

- `plan/01-llm/spec.md`
- `plan/01-llm/plan.md`

阅读 `spec.md` 时，重点理解本章要交付什么、明确不做什么，以及用户最终能够完成哪些操作。

阅读 `plan.md` 时，重点理解模块职责、依赖方向、核心数据类型和一轮消息的数据流。暂时不需要记忆所有文件名或实现细节。

## 本章目标

第 01 章负责建立 QiCode 最小可用的终端对话闭环：

- 从 YAML 配置读取 Anthropic 或 OpenAI Provider。
- 用户可以在 TUI 中输入问题。
- 模型回复通过 SSE 流式显示。
- 当前进程内支持多轮对话。
- Anthropic 支持 extended thinking。
- 单轮请求失败后，用户仍可以继续对话。
- `/exit` 和 `Ctrl+C` 可以安全退出。

本章完成后，QiCode 是一个终端 AI 对话程序，还不是完整的 Coding Agent。

本章不实现 Tool use、文件操作、Shell、代码编辑、MCP、Skills、长期记忆、会话持久化和上下文压缩。

## 用户实际经历的流程

```text
用户启动 QiCode
        ↓
读取并校验 YAML 配置
        ↓
只有一个 Provider：直接进入对话
多个 Provider：用户选择一个
        ↓
根据 protocol 创建具体 Provider
        ↓
用户输入问题并提交
        ↓
用户消息加入会话历史
        ↓
Provider 携带完整历史发起请求
        ↓
HTTP 响应流进入 SSE 解析器
        ↓
具体 Provider 转换为统一 StreamEvent
        ↓
TUI 实时显示文本增量和请求状态
        ↓
响应结束后保存助手消息
        ↓
用户继续下一轮，或退出程序
```

阅读本章时，需要抓住以下主线：

```text
配置 → Provider → SSE → Conversation → TUI
```

## 核心理解问题

### 1. 第 01 章要交付什么？明确不做什么？

回答关键字：

```text
TUI、双 Provider、SSE 流式、多轮上下文、extended thinking
不做 Tool、文件操作、Agent Loop、长期记忆
```

### 2. 用户提交问题后，消息经过哪些模块？

回答关键字：

```text
InputBox → App → Conversation → Provider
→ fetch → SSE → StreamEvent → TUI
```

### 3. 为什么需要统一 Provider 接口？

回答关键字：

```text
隔离协议差异、TUI 不感知厂商、统一事件
降低耦合、方便增加新 Provider
```

### 4. SSE 解析器和具体 Provider 分别负责什么？

回答关键字：

```text
SSE：字节流、事件边界、data 行、拆包与粘包
Provider：厂商请求格式、业务 JSON、事件映射
通用层不理解厂商协议
```

### 5. 为什么网络 chunk 不能直接当成一条模型消息？

回答关键字：

```text
chunk 边界随机、一个事件可能被拆开
一个 chunk 可能包含多个事件、需要缓冲区
TextDecoder、事件分隔符
```

### 6. 多轮对话中的“记住历史”是如何实现的？

回答关键字：

```text
Conversation 内存历史
每轮重新发送完整 messages
模型不会自动记住
进程退出后历史清空
```

### 7. Claude extended thinking 为什么不展示却还要保存？

回答关键字：

```text
ThinkingBlock、hidden、signature
Anthropic 后续多轮需要
正文显示、思考隐藏、不能直接丢弃
```

### 8. 为什么 Provider 返回 `AsyncIterable<StreamEvent>`？

回答关键字：

```text
异步增量、for await
收到一段处理一段、即时渲染
统一 text、thinking、usage、done
```

### 9. 配置错误和单轮网络错误为什么处理方式不同？

回答关键字：

```text
配置错误：无法启动、非零退出
网络错误：只影响当前回合
保留用户输入、恢复 idle、允许继续对话
```

### 10. 用户退出、取消或请求超时时，怎样停止网络请求？

回答关键字：

```text
AbortController、AbortSignal、fetch
终止响应流、清理计时器
恢复终端状态、避免连接泄漏
```

## 开发前通过标准

不要求背诵文档，也不要求第一次回答就非常专业。开始开发前，至少应当能够用自己的话说明：

1. 本章做什么、不做什么。
2. 用户提交消息后的完整主流程。
3. Provider 为什么需要抽象。
4. SSE 为什么需要缓冲。
5. 多轮上下文如何实现。
6. thinking 为什么隐藏但不能丢弃。

推荐学习流程：

```text
阅读 spec 和 plan
        ↓
不看关键字回答 10 个问题
        ↓
让 Codex 检查理解
        ↓
纠正遗漏或错误
        ↓
开始第一个开发阶段
```
=======
=======
>>>>>>> theirs
=======
>>>>>>> theirs
# 第 01 章：QiCode 怎样把一句话交给 LLM

> 🎓 学习目标：沿着一次真实提问，理解 QiCode 如何从终端输入走到模型请求，再回到终端显示。

## 1. 全局地图 🗺️

### 1.1 问题：我输入一句话后，代码从哪里开始执行？

💡 原理：LLM 不在 QiCode 项目内部执行。QiCode 是客户端，负责收集问题、准备上下文、通过网络请求模型，再接收回复。

~~~mermaid
flowchart LR
    U["👤 用户输入"] --> I["⌨️ InputBox"]
    I --> A["🖥️ App.submit"]
    A --> C["🧾 Conversation"]
    A --> G["🧠 Agent.run"]
    G --> P["🔌 Provider.stream"]
    P --> L["☁️ OpenAI/Anthropic API"]
    L --> P --> G --> A --> V["🖥️ ChatView"]
~~~

📍 入口是 [src/main.tsx](../../../../src/main.tsx)，界面在 [src/tui/app.tsx](../../../../src/tui/app.tsx)，Agent 在 [src/agent/agent.ts](../../../../src/agent/agent.ts)，LLM 通信在 [src/llm](../../../../src/llm)。

🔮 下一个问题：项目连接哪个模型、地址和密钥，是不是写死在代码里？

## 2. 配置：先描述模型服务 ⚙️

### 2.1 问题：同一套 Agent 如何连接不同模型厂商？

💡 原理：把经常变化的连接信息放进配置，把稳定逻辑留在代码里。ProviderConfig 定义在 [src/config/types.ts](../../../../src/config/types.ts:3)：

~~~ts
export interface ProviderConfig {
  name: string;
  protocol: "anthropic" | "openai";
  model: string;
  base_url: string;
  api_key: string;
  thinking: boolean;
}
~~~

启动时 [src/main.tsx](../../../../src/main.tsx) 调用 loadConfig(configPath)，再把 config.providers 交给 App。一个 Provider 自动使用；多个 Provider 则由界面选择。

🔮 下一个问题：配置只是数据，代码怎样根据 protocol 创建真正能发请求的对象？

## 3. Provider：统一不同厂商的接口 🔌

### 3.1 问题：OpenAI 和 Anthropic 的 HTTP 格式不同，App 要分别处理吗？

💡 不应该。App 只需要“发起流式请求并接收事件”，不应知道不同厂商的认证头和 JSON 格式。因此项目定义统一 Provider 接口，位于 [src/llm/client.ts](../../../../src/llm/client.ts:12)：

~~~ts
export interface Provider {
  readonly config: ProviderConfig;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
}
~~~

createProvider() 根据协议选择 OpenAIProvider 或 AnthropicProvider。Agent 依赖的是这个接口，而不是某一家厂商，这就是面向接口编程。

🔮 下一个问题：用户输入的文字怎样进入模型请求？

## 4. Conversation：手动保存多轮历史 🧾

### 4.1 问题：模型会自动记住上一轮聊天吗？

💡 不会。每次 HTTP 请求都要带上需要的历史。Conversation 位于 [src/conversation/conversation.ts](../../../../src/conversation/conversation.ts)，用户提交时 App 执行：

~~~ts
conversationRef.current.addUserMessage(rawText);
~~~

它保存结构化消息：

~~~ts
{ role: "user", content: [{ type: "text", text: rawText }] }
~~~

Agent 调用 Provider 时取出完整历史：

~~~ts
messages: this.config.conversation.getMessages()
~~~

🔮 下一个问题：谁负责把历史、系统提示词和 Provider 组织成一次任务？

## 5. Agent：协调一次请求 🧠

### 5.1 问题：App 已有输入，为什么还需要 Agent？

💡 App 负责界面状态；Agent 负责任务执行。提交后 [src/tui/app.tsx](../../../../src/tui/app.tsx:334) 创建 Agent：

~~~ts
const agent = new Agent({
  provider: runtime.provider,
  registry,
  conversation: conversationRef.current,
  systemPrompt: runtime.systemPrompt,
  workDir,
  abortSignal: controller.signal,
  checker: new PermissionChecker(workDir, mode),
});
~~~

Agent 在 [src/agent/agent.ts](../../../../src/agent/agent.ts:128) 调用 Provider，并使用 for await 持续接收事件：

~~~ts
for await (const event of this.config.provider.stream({
  systemPrompt: this.config.systemPrompt,
  messages: this.config.conversation.getMessages(),
  tools,
  signal: this.config.abortSignal,
})) {
  // 逐个处理模型事件
}
~~~

🔮 下一个问题：为什么不是等完整答案返回，而是一个字一个字显示？

## 6. 流式响应：让用户立即看到结果 📡

### 6.1 问题：流式到底解决了什么？

💡 完整等待会让界面长时间没有反馈。OpenAI Provider 在 [src/llm/openai.ts](../../../../src/llm/openai.ts:27) 使用 fetch 发送 POST /chat/completions，并带上模型、历史消息和 stream: true。Anthropic Provider 做相同工作，但请求格式不同。

两个 Provider 都把厂商原始 SSE 翻译成统一 StreamEvent，定义在 [src/llm/events.ts](../../../../src/llm/events.ts)：

~~~text
text_delta：新增文本
thinking_delta：新增思考内容
tool_call_complete：模型请求调用工具
usage：Token 统计
done：输出结束
~~~

🔮 下一个问题：事件到达 App 后，怎样显示在终端？

## 7. 从事件回到界面 🖥️

### 7.1 问题：收到一段文本后，谁更新屏幕？

💡 在 [src/tui/app.tsx](../../../../src/tui/app.tsx:368)，App 消费 Agent 事件：

~~~ts
if (event.type === "stream_text") {
  setStreamingText((current) => current + event.text);
  setStatus("streaming");
}
~~~

完整接力是：模型文本 → Provider 的 text_delta → Agent 的 stream_text → App 更新 streamingText → ChatView 重新渲染。结束后，Agent 把助手消息写回 Conversation。

## 8. 本章和 Agent 项目的关系 🎯

### 8.1 问题：只有 LLM 通信，QiCode 已经是完整 Agent 吗？

💡 还不完整。本章提供“大脑通信”：模型能理解问题并返回判断，但不能直接读文件、修改代码或执行命令。

~~~mermaid
flowchart LR
    A["🧠 01 LLM"] --> B["🧰 02 Tools"] --> C["🔁 03 Loop"] --> D["💬 04 Prompt"] --> E["🔐 05 Permission"] --> F["🔌 06 MCP"]
~~~

MCP 不会替换 LLM；它只是把外部服务接入工具注册表，之后仍由 Agent 把工具说明交给模型、接收调用并回填结果。

## 9. 面试表达 🎤

### 9.1 问题：面试官问“你的 Agent 怎样调用模型”，怎么回答？

💡 可以这样说：QiCode 启动时从 YAML 读取 Provider 配置，依据 protocol 创建 OpenAI 或 Anthropic Provider。用户提交消息后，App 把消息写入 Conversation 并创建 Agent；Agent 组合系统提示词、历史消息、工具定义和取消信号，调用统一的 Provider.stream()。具体 Provider 处理厂商 HTTP/SSE 差异并翻译成统一事件；App 消费事件并实时渲染，结束后把助手回复写回会话，从而支持多轮对话。

这体现三个工程选择：配置与代码分离、Provider 抽象、流式事件统一。

## 10. 自测与下一章 🔮

### 10.1 问题：不看代码，你能回答吗？

- 🧠 谁保存聊天历史？答案：Conversation。
- 🔌 protocol 决定什么？答案：创建哪一种 Provider。
- 📡 为什么返回 AsyncIterable<StreamEvent>？答案：边接收边显示，并隐藏厂商差异。
- 🖥️ 为什么 App 不直接调用 API？答案：界面、任务协调和网络通信各负其责。
- 🔮 下一章解决什么？答案：给只能思考的模型接入读文件、写文件和执行命令等工具。
<<<<<<< ours
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs
=======
>>>>>>> theirs
