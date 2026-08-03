# QiCode 第一阶段技术计划：LLM 终端对话

> 状态：规划中，等待用户明确说“开发”后执行。
>
> 需求依据见 `spec.md`。本文只描述架构、技术决策和验证策略，不作为任务进度表。

## 1. 技术决策摘要

| 主题 | 决策 | 原因 |
|---|---|---|
| 语言 | TypeScript 7.0.2 | 当前 lockfile 已安装并通过严格类型检查；后续升级以实际验证结果为准 |
| 运行时 | Node.js 22 LTS | 稳定、跨平台，内置 `fetch`、Web Streams 和 `AbortController` |
| 包管理器 | pnpm 10.14.0 | 与当前环境一致，并通过 `packageManager` 和 `pnpm-lock.yaml` 固定工具与依赖图 |
| 开发运行 | `tsx` | Node 不直接执行 `.ts/.tsx`，开发期无需手动编译 |
| 生产运行 | `tsc` 编译后由 Node 执行 | `bin` 指向稳定的 `dist/main.js`，不依赖全局 TypeScript 运行器 |
| TUI | Ink + React | 组件化管理终端布局、输入和流式状态 |
| HTTP | Node 原生 `fetch` | 两个 Provider 都使用 SSE，无需为首期引入两套 SDK |
| YAML | `js-yaml` | 成熟、轻量，满足六字段配置解析 |
| 测试 | Vitest 4.1.10 | 当前 lockfile 已验证，适合单元与本地流式集成测试 |
| Markdown | `marked` + `marked-terminal` | 响应完成后生成适合终端的文本样式 |

## 2. pnpm 工作流

`package.json` 应声明：

```json
{
  "packageManager": "pnpm@10.14.0",
  "type": "module",
  "bin": {
    "qicode": "./dist/main.js"
  },
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

约定：

- 使用 `pnpm install` 安装依赖。
- 使用 `pnpm <script>` 运行脚本，不混用 Bun、npm 或 Yarn 命令。
- `pnpm-lock.yaml` 必须提交版本库，不加入 `.gitignore`。
- `node_modules/`、`dist/`、覆盖率产物和真实配置文件不提交。
- 第 1 次开发使用无 JSX 的 `src/main.ts` 作为开发入口，发布入口是 `dist/main.js`；第 5 次接入 Ink/React 后再迁移为 `src/main.tsx`，并同步更新脚本与测试。
- CI 或干净环境使用 `pnpm install --frozen-lockfile`；新增依赖需检查 lockfile 和安装脚本。

## 3. 依赖边界

### 3.1 运行依赖

- `ink`、`react`：TUI。
- `chalk`：少量终端颜色语义。
- `js-yaml`：配置解析。
- `marked`、`marked-terminal`：完成消息的 Markdown 渲染。

### 3.2 开发依赖

- `typescript`：类型检查和构建。
- `tsx`：开发期执行 TypeScript/TSX。
- `vitest`：测试。
- `@types/node`、`@types/react`、`@types/js-yaml`：类型声明。

首期不引入以下依赖：

- Anthropic/OpenAI SDK：直接用 `fetch` 统一处理 SSE，减少重复抽象。
- `ink-text-input`：它主要面向单行输入，本项目需要可控的多行输入行为。
- `fuse.js`：本阶段没有命令面板或文件选择。

第 1 次开发已锁定并验证：Node.js 22.21.1、pnpm 10.14.0、TypeScript 7.0.2、tsx 4.23.1、Vitest 4.1.10、js-yaml 5.2.2。后续以 `package.json` 与 `pnpm-lock.yaml` 为事实来源，文档随验证结果校准。

## 4. 目录结构

```text
QiCode/
├─ src/
│  ├─ main.ts                     # 第 1 次版本入口；第 5 次接入 Ink 后迁移为 main.tsx
│  ├─ config/
│  │  ├─ types.ts                 # ProviderConfig / AppConfig
│  │  └─ load-config.ts           # YAML 解析、环境变量引用、校验
│  ├─ conversation/
│  │  ├─ types.ts                 # Message 与隐藏 thinking block
│  │  └─ conversation.ts          # 当前进程内的历史管理
│  ├─ prompt/
│  │  └─ system-prompt.ts         # 首期最小系统提示词
│  ├─ llm/
│  │  ├─ events.ts                # StreamEvent、UsageInfo 与工具契约
│  │  ├─ client.ts                # Provider、工厂、错误、HTTP、URL 与 SSE
│  │  ├─ anthropic.ts             # Anthropic 请求与事件映射
│  │  └─ openai.ts                # OpenAI 请求与事件映射
│  └─ tui/
│     ├─ app.tsx                  # 顶层状态机与一轮对话编排
│     ├─ header.tsx               # 固定三行猫头 ASCII 品牌标识与紧凑顶部信息
│     ├─ provider-select.tsx      # 启动选择
│     ├─ chat-view.tsx            # 历史与流式正文
│     ├─ input-box.tsx            # 多行输入
│     ├─ activity.tsx             # Spinner 与计时
│     ├─ status-bar.tsx           # Provider、模型和 token
│     └─ sanitize-terminal.ts      # 清理不可信终端控制字符
├─ tests/
│  ├─ config/
│  ├─ conversation/
│  ├─ llm/
│  └─ tui/
├─ config.example.yaml
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
└─ tsconfig.build.json
```

目录只为本阶段范围服务，不预建 `tools/`、`agent/`、`permissions/`、`memory/` 或 `mcp/`。

## 5. 分层架构

```text
main.tsx
  -> config/load-config
  -> tui/App
       -> conversation
       -> prompt/system-prompt
       -> llm/create-provider
            -> AnthropicProvider
            -> OpenAIProvider
                 -> shared SSE parser
```

依赖规则：

1. TUI 可以依赖 Provider 契约，但不能导入具体协议类。
2. Provider 可以读取统一消息类型，但不能依赖 Ink 或 React。
3. SSE 解析器只负责字节流到 SSE 事件，不理解 Anthropic/OpenAI 业务字段。
4. 配置层不发网络请求。
5. 会话层不负责界面渲染，也不持久化数据。

## 6. 核心类型

### 6.1 配置类型

```ts
type Protocol = "anthropic" | "openai";

interface ProviderConfig {
  name: string;
  protocol: Protocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking?: boolean;
}

interface AppConfig {
  providers: ProviderConfig[];
}
```

`ProviderConfig` 不加入上下文窗口、最大输出 token、权限或 MCP 字段。协议所需的首期默认值放在实现常量中。

### 6.2 会话类型

```ts
type TextBlock = {
  type: "text";
  text: string;
};

type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
  hidden: true;
};

interface ConversationMessage {
  role: "user" | "assistant";
  content: Array<TextBlock | ThinkingBlock>;
}
```

说明：

- 用户消息只有文本块。
- 普通助手消息只有文本块。
- Anthropic extended thinking 的助手消息可同时包含隐藏思考块和文本块。
- TUI 只渲染文本块；Anthropic Provider 在下一轮请求中恢复完整块序列。
- OpenAI Provider 只映射历史中的文本块。

### 6.3 Provider 契约

```ts
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "done"; stopReason?: string };

interface ChatRequest {
  systemPrompt: string;
  messages: ConversationMessage[];
  signal?: AbortSignal;
}

interface Provider {
  readonly config: ProviderConfig;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
}
```

Provider 工厂只根据 `protocol` 创建具体实现：

```ts
function createProvider(config: ProviderConfig): Provider;
```

## 7. 配置加载设计

加载顺序：

1. 解析 `--config <path>`；未指定时先检查当前工作目录下 `.QiCode/config.yaml`，不存在则回退到用户主目录 `.QiCode/config.yaml`。
2. 读取 UTF-8 文本并调用 `js-yaml`。
3. 确认顶层仅需要 `providers` 数组。
4. 对每个 Provider 校验六字段、协议值、URL、名称唯一性与 thinking 约束。
5. 若 `api_key` 完整匹配 `${ENV_NAME}`，解析环境变量。
6. 返回新的配置对象，后续错误信息不再携带原始 YAML。

不实现多层配置合并，避免在第一阶段引入未被原始需求要求的覆盖规则。

## 8. SSE 解析设计

通用解析器接收 `ReadableStream<Uint8Array>`，输出：

```ts
interface SSEMessage {
  event?: string;
  data: string;
}
```

处理规则：

- 使用 `TextDecoder` 的流式模式处理 UTF-8 字符跨 chunk。
- 同时接受 `\n\n` 与 `\r\n\r\n` 事件分隔。
- 同一事件的多个 `data:` 行以换行连接。
- 忽略 `:` 开头的注释行。
- 保留可选 `event:` 字段。
- 流结束时处理最后一个未带空行但内容完整的事件。
- JSON 解析由具体 Provider 完成。
- 对单行、单事件和累计缓冲设置合理上限，超限时抛 `ProviderResponseError`。

重点测试：单字节拆包、一个 chunk 多事件、CRLF、多行 data、注释、空 data、结束标记和非法 JSON。

## 9. Anthropic Provider

### 9.1 请求

- URL：保留 `base_url` 既有路径，并保证最终资源前恰好只有一个 `v1`。例如
  `https://api.anthropic.com` 与 `https://api.anthropic.com/v1` 都应解析为
  `https://api.anthropic.com/v1/messages`。
- Headers：`content-type`、`x-api-key`、`anthropic-version`。
- Body：`model`、`system`、`messages`、`stream: true`、`max_tokens`。
- `thinking: true` 时增加 Anthropic extended thinking 参数。
- thinking budget 与 `max_tokens` 使用实现常量；开始开发时根据目标模型 API 约束验证。

### 9.2 响应映射

- `text_delta` -> 统一 `text_delta`。
- `thinking_delta` -> 统一 `thinking_delta`，只在内存累积。
- `signature_delta` -> 与当前 thinking block 的签名累积。
- thinking block 结束 -> `thinking_complete`。
- usage 字段 -> 统一 `usage`。
- message 结束 -> `done`。

### 9.3 多轮 thinking

一轮完成后，App 将完整 thinking 内容和 signature 写入隐藏 `ThinkingBlock`，正文写入 `TextBlock`。
下一轮 Anthropic 请求按原顺序发送这些块。界面始终不显示隐藏块。

## 10. OpenAI Provider

### 10.1 请求

- URL：保留 `base_url` 既有路径，并保证最终资源前恰好只有一个 `v1`。例如
  `https://api.openai.com` 与 `https://api.openai.com/v1` 都应解析为
  `https://api.openai.com/v1/chat/completions`。
- Headers：`content-type`、`authorization: Bearer ...`。
- Body：`model`、`messages`、`stream: true`、`stream_options.include_usage: true`。
- `base_url` 同时覆盖官方与兼容服务。

### 10.2 响应映射

- `choices[].delta.content` -> 统一 `text_delta`。
- `usage` -> 统一 `usage`。
- `finish_reason` 或 `[DONE]` -> `done`。
- 兼容端点缺少 usage 时保持未知，不填充虚假 token 数。

## 11. 错误模型

统一错误类型：

| 类型 | 典型来源 | 用户提示策略 |
|---|---|---|
| `ConfigError` | 文件、YAML、字段或环境变量错误 | 启动失败，指出配置位置 |
| `AuthenticationError` | HTTP 401/403 | 提示检查 Key、地址和模型权限 |
| `RateLimitError` | HTTP 429 | 提示限流，可展示安全的 retry-after |
| `ContextTooLongError` | 上下文超限 | 提示开始新会话或缩短输入 |
| `NetworkError` | DNS、超时、连接中断 | 提示网络或 `base_url` 问题 |
| `ProviderResponseError` | 非法 SSE/JSON 或未知协议响应 | 提示响应无法解析，不展示敏感原文 |
| `AbortError` | 用户退出或主动取消 | 作为中断处理，不显示错误堆栈 |

HTTP 非成功响应只读取有限长度的安全摘要。任何错误格式化都必须经过 API Key 脱敏。
请求使用统一超时与 `AbortController`；重定向不得把鉴权信息带到意外主机。

## 12. TUI 状态设计

`header.tsx` 内置固定三行猫头：` /\_/\`、`( o.o )`、` > ^ <`，上、下两行相对中间行右移一格，不允许自行改变轮廓或增加身体。使用 Ink 横向布局把它与三行元信息并排展示：版本、`protocol · model`、工作目录。字符画不进入消息数据；两栏之间使用布局间距而不是依赖字符串尾随空格。可用列数或高度不足时隐藏猫头，元信息改为纵向纯文本。测试验证三行字符、信息顺序和窄屏降级，不做脆弱的整屏空格快照。

顶层状态：

Ink 启动时必须设置 `exitOnCtrlC: false`，关闭框架默认的单次退出行为；`App` 统一实现第一次取消/提示、1.5 秒内第二次退出。

```ts
type Screen = "selecting" | "chat";
type TurnStatus = "idle" | "waiting" | "streaming" | "failed";
```

主要状态：

- 当前 Provider。
- 已提交消息。
- 当前输入文本与光标位置。
- 当前流式正文。
- 当前隐藏 thinking 与 signature。
- 当前请求耗时和 token 用量。
- 当前错误。
- `AbortController`。

一轮对话状态转换：

```text
idle
  -> submit
waiting
  -> first text/thinking event
streaming
  -> done
idle

waiting/streaming
  -> provider or network error
failed
  -> error rendered and input re-enabled
idle
```

用户输入和模型输出都视为不可信文本。进入 Ink 或 Markdown 解析器前，保留正常换行与
制表符，移除 ANSI escape、OSC 和其他会改变终端状态的控制序列；之后才允许终端 Markdown
渲染器生成受控样式。清理只影响展示，不改写发送给模型的会话正文。

## 13. 一轮对话的数据流

```text
InputBox.submit(text)
  -> Conversation.addUser(text)
  -> App sets waiting + starts timer
  -> Provider.stream({ systemPrompt, history, signal })
       -> fetch
       -> shared SSE parser
       -> provider-specific JSON mapping
       -> unified StreamEvent
  -> text_delta: append visible streaming text
  -> thinking events: append hidden block only
  -> usage: update status bar
  -> done: commit assistant blocks to Conversation
  -> clear dynamic stream state and enable input
```

## 14. 测试策略

### 14.1 单元测试

- 配置路径、六字段校验、名称重复、环境变量引用和脱敏。
- Conversation 返回副本、顺序正确、隐藏 thinking 不被文本读取方法暴露。
- SSE 的 chunk 边界和行规则。
- URL 拼接保留 `/v1` 等现有路径，且不生成重复资源路径。
- 两个 Provider 的请求体映射与事件映射。
- 错误分类和安全提示。
- 终端控制序列不会进入渲染输出。

### 14.2 组件测试

- Provider 选择键盘行为。
- 输入框的 Enter 提交和禁用状态。
- 流式增量、完成消息与错误状态的渲染。

### 14.3 本地集成测试

- 使用本地 HTTP server 返回可控 SSE，不调用外部 LLM。
- 验证两个 Provider 的 URL、Headers、Body、取消和部分响应保留。

### 14.4 手工验收

- 用真实 Anthropic 配置验证 extended thinking 与多轮。
- 用真实 OpenAI 或兼容端点验证流式多轮。
- Windows、macOS 或 Linux 至少覆盖当前开发环境；其他平台列为人工兼容验证。

## 15. 风险与处理

| 风险 | 影响 | 处理方式 |
|---|---|---|
| 终端无法稳定区分 Shift+Enter 与 Enter | 键盘换行在不同终端表现不一致 | 保持符合终端习惯的 Enter 提交，本阶段不提供键盘换行 |
| extended thinking 历史被丢弃 | Anthropic 后续请求失败或语义不完整 | 隐藏保存 thinking 与 signature |
| 兼容端点 SSE 格式不完全一致 | OpenAI 流解析失败 | 宽容处理缺失 usage，严格报告非法 JSON |
| `base_url` 带尾斜杠 | URL 出现重复斜杠 | 统一规范化后拼接路径 |
| API Key 出现在错误对象中 | 密钥泄漏 | 所有用户错误统一脱敏，不直接 stringify 原错误 |
| 模型输出包含 ANSI/OSC 序列 | 伪造提示或改变终端状态 | 展示前清理终端控制序列 |
| SSE 事件或连接无限增长 | 内存或连接资源耗尽 | 设置事件大小上限、请求超时和取消路径 |
| Markdown 流式解析闪烁 | TUI 频繁重排 | 流式期间显示纯文本，完成后再渲染 Markdown |
| Ink 动态区与历史区重复 | 对话内容重复显示 | 已完成消息使用静态区，当前轮保留在动态区 |

## 16. 完成定义

第一阶段只有同时满足以下条件才算完成：

1. `spec.md` 的验收项全部有对应测试或手工证据。
2. `pnpm typecheck`、`pnpm test`、`pnpm build` 通过。
3. Anthropic 与 OpenAI 的真实流式对话各验证一次。
4. extended thinking 不显示但可跨轮继续。
5. API Key 未进入代码、示例值、日志或测试输出。
6. 退出后终端状态正常。
7. 实现范围没有扩展到工具、文件或 Agent 能力。
8. `pnpm audit --prod` 的发现已按可达性审查，无未处理的高危运行时问题。
