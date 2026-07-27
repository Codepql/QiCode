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
