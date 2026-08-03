# QiCode 第一阶段任务清单：LLM 终端对话

> 状态：未开始。只有用户明确说“开发”后才执行本清单。
>
> 需求见 `spec.md`，架构见 `plan.md`。任务按依赖顺序排列，每项都包含验收与验证。

## 1. 执行规则

- 使用 pnpm，不运行 Bun、npm 或 Yarn 命令。
- 每个行为改动先写失败测试，再做最小实现。
- 每完成一个任务，运行该任务的聚焦测试和 `pnpm typecheck`。
- 每个检查点再运行完整 `pnpm test` 与 `pnpm build`。
- 不创建本阶段范围外的工具、权限、MCP、记忆或文件操作模块。
- 不把真实 API Key 写入仓库或测试。

## 2. 任务总览

| 阶段 | 任务 | 结果 |
|---|---|---|
| 基础 | T1. 初始化 Node + pnpm + TypeScript 工程 | 可开发、测试、构建、运行 |
| 配置 | T2. 实现六字段 YAML 配置 | 安全得到可用 Provider 配置 |
| 核心契约 | T3. 建立会话、Provider 与错误类型 | 上层不感知协议差异 |
| 流式基础 | T4. 实现通用 SSE 解析器 | 两个 Provider 共享可靠流解析 |
| 协议 | T5. 实现 Anthropic Provider | 支持流式与 extended thinking |
| 协议 | T6. 实现 OpenAI Provider | 支持官方与兼容端点 |
| 终端界面 | T7. 实现静态布局与基础组件 | 界面层次清晰、窄屏可读 |
| 对话编排 | T8. 实现输入、多轮与流式状态机 | 完成可恢复的交互式对话 |
| 装配 | T9. 实现 CLI 入口和配置示例 | 可从命令行完整启动 |
| 验收 | T10. 完成集成验证和质量检查 | 满足规格中的完成定义 |

## 3. 任务详情

### T1. 初始化 Node + pnpm + TypeScript 工程

**目标**

建立最小可运行工程，明确开发入口与发布入口。

**文件**

- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `tsconfig.build.json`
- `.gitignore`
- `src/main.ts`（第 1 次无 JSX 入口；第 5 次接入 Ink 后迁移为 `src/main.tsx`）

**实施步骤**

1. 使用 `pnpm init` 创建项目元数据。
2. 设置 `type: module`、`packageManager: pnpm@10.14.0` 和 `bin.qicode: ./dist/main.js`。
3. 添加 `dev`、`build`、`start`、`typecheck`、`test`、`test:watch` scripts。
4. 安装 `typescript`、`tsx`、`vitest` 和所需类型声明；具体版本以安装后通过测试、类型检查和构建的 lockfile 为准。
5. TypeScript 使用严格模式、Node ESM、React JSX；构建配置输出到 `dist/`。
6. 临时 `src/main.ts` 入口只输出版本信息；源文件保留 Node shebang，并用 `import.meta.url` 判断直接执行，避免测试导入时产生输出。第 5 次接入 Ink 后迁移为 `.tsx`。
7. `.gitignore` 忽略 `node_modules/`、本地 `.pnpm-store/`、`dist/`、coverage 和真实本地配置，不忽略 `pnpm-lock.yaml`。
8. 记录干净环境使用 `pnpm install --frozen-lockfile`，审查新增依赖的安装脚本。

**验收**

- [ ] 项目中没有 Bun 依赖、`bun.lock`、`@types/bun` 或 Bun shebang；`pnpm-lock.yaml` 必须存在。
- [ ] `pnpm dev` 能运行源码入口。
- [ ] `pnpm build` 生成 `dist/main.js`。
- [ ] `pnpm start` 能运行构建产物。

**验证**

```text
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

---

### T2. 实现六字段 YAML 配置

**依赖**：T1

**目标**

按照规格加载、校验并安全解析 Provider 配置。

**文件**

- `src/config/types.ts`
- `src/config/load-config.ts`
- `tests/config/load-config.test.ts`

**先写测试**

- 合法的 Anthropic 与 OpenAI 配置成功加载。
- 缺少五个必填字段中的任意一个时失败。
- 非法 `protocol`、非法 `base_url`、重复 `name` 时失败。
- `thinking` 非 boolean 或用于 OpenAI 且为 true 时失败。
- `${ENV_NAME}` 能解析，缺失环境变量时失败。
- 错误文本不包含 API Key。
- 默认路径与 `--config` 指定路径都可解析。

**实施步骤**

1. 定义 `Protocol`、`ProviderConfig` 和 `AppConfig`。
2. 读取 UTF-8 YAML，校验顶层 `providers` 数组。
3. 逐条校验 `name`、`protocol`、`model`、`base_url`、`api_key`、`thinking`。
4. 解析严格的环境变量引用语法。
5. 输出不包含原始配置对象的 `ConfigError`。

**验收**

- [ ] Provider 配置只有规格定义的六个字段。
- [ ] 配置错误能定位到 Provider 与字段。
- [ ] API Key 不出现在异常消息与测试输出中。

**验证**

```text
pnpm test -- tests/config/load-config.test.ts
pnpm typecheck
```

---

### T3. 建立会话、Provider 与错误类型

**依赖**：T1

**目标**

先确定协议无关的类型边界，再实现具体 Provider。

**文件**

- `src/conversation/types.ts`
- `src/conversation/conversation.ts`
- `src/llm/events.ts`
- `src/llm/client.ts`
- `tests/conversation/conversation.test.ts`

**先写测试**

- 用户和助手消息按顺序追加。
- 读取历史返回副本，不允许调用方修改内部数组。
- 助手消息可同时保存隐藏 thinking 和可见 text。
- 提供给 TUI 的文本读取方法不会返回 thinking 内容。
- 错误格式化可分类且会对已知 Key 进行脱敏。

**实施步骤**

1. 定义 `TextBlock`、`ThinkingBlock`、`ConversationMessage`。
2. 实现只在内存工作的 `Conversation`。
3. 定义 `StreamEvent`、`ChatRequest` 和 `Provider`。
4. 定义统一错误类和安全用户消息格式化函数。

**验收**

- [ ] 会话层不引用 React、Ink 或具体 Provider。
- [ ] Provider 契约不包含 tool 参数或 tool 事件。
- [ ] thinking 可保留但不会进入可见正文。

**验证**

```text
pnpm test -- tests/conversation/conversation.test.ts
pnpm typecheck
```

---

### T4. 实现通用 SSE 解析器

**依赖**：T3

**目标**

把任意拆分方式的 HTTP 字节流稳定转换为 SSE 消息。

**文件**

- `src/llm/client.ts`
- `tests/llm/sse.test.ts`
- `tests/llm/url.test.ts`

**先写测试**

- 一个 chunk 包含一个或多个事件。
- 一个事件跨多个 chunk，甚至单字节拆分。
- 支持 LF 和 CRLF。
- 多个 `data:` 行正确拼接。
- 忽略注释，保留 `event:`。
- 正确处理 UTF-8 多字节字符跨 chunk。
- 流结束前没有尾部空行时仍处理完整事件。
- 超过单事件或累计缓冲上限时安全失败。
- URL 拼接保留 `base_url` 中已有路径，处理尾斜杠，并保证最终资源前恰好一个 `/v1`。

**实施步骤**

1. 使用流式 `TextDecoder` 解码字节。
2. 按空行切分事件帧。
3. 解析 `event:` 与 `data:` 行。
4. 通过 `AsyncGenerator<SSEMessage>` 输出，不解析业务 JSON。
5. 实现共享 URL 拼接函数，禁止使用会丢弃基础路径的错误 `new URL("/path", base)` 写法。

**验收**

- [ ] SSE 解析器不包含 Anthropic/OpenAI 条件分支。
- [ ] 所有 chunk 边界测试稳定通过。
- [ ] 解析过程可响应 AbortSignal 导致的上游中断。

**验证**

```text
pnpm test -- tests/llm/sse.test.ts tests/llm/url.test.ts
pnpm typecheck
```

## 4. 检查点 A：基础边界

- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过。
- [ ] `pnpm build` 通过。
- [ ] 配置、会话、Provider 契约和 SSE 之间没有循环依赖。
- [ ] 没有出现工具调用或后续阶段占位类型。

---

### T5. 实现 Anthropic Provider

**依赖**：T2、T3、T4

**目标**

支持 Anthropic Messages API 的流式正文与 extended thinking。

**文件**

- `src/llm/anthropic.ts`
- `tests/llm/anthropic.test.ts`

**先写测试**

- URL、Headers 和基本请求体正确。
- 普通多轮历史映射正确。
- `thinking: true` 时加入 thinking 参数。
- 历史中的 hidden thinking 与 signature 按原顺序发回 Anthropic。
- 文本、思考、签名、usage 和结束事件映射正确。
- 401、429、上下文超限、网络错误和非法 JSON 分类正确。
- AbortSignal 会中止 fetch。

**实施步骤**

1. 将统一会话消息映射为 Anthropic content blocks。
2. 通过原生 `fetch` 发起 `/v1/messages` 流式请求。
3. 使用通用 SSE 解析器读取事件。
4. 累积 thinking 与 signature，并输出统一事件。
5. 限制错误响应摘要长度并脱敏。

**验收**

- [ ] TUI 上层不需要理解 Anthropic 事件名。
- [ ] thinking 不作为正文事件输出。
- [ ] thinking block 完成时包含可供下一轮使用的 signature。

**验证**

```text
pnpm test -- tests/llm/anthropic.test.ts
pnpm typecheck
```

---

### T6. 实现 OpenAI Provider 与 Provider 工厂

**依赖**：T2、T3、T4

**目标**

支持 OpenAI Chat Completions SSE，并用同一协议适配官方与兼容端点。

**文件**

- `src/llm/openai.ts`
- `src/llm/client.ts`
- `tests/llm/openai.test.ts`
- `tests/llm/client.test.ts`

**先写测试**

- `base_url` 有无尾斜杠都生成正确 URL。
- Authorization、model、messages、stream 和 usage 选项正确。
- 历史中的 hidden thinking 不发送给 OpenAI。
- `delta.content`、usage、finish reason 和 `[DONE]` 映射正确。
- 缺失 usage 时保持未知。
- 常见 HTTP 与网络错误分类正确。
- 工厂按两种 protocol 返回正确实现。

**实施步骤**

1. 将统一消息历史映射为 OpenAI 文本 messages。
2. 通过原生 `fetch` 发起 `/v1/chat/completions` 流式请求。
3. 映射统一事件并处理 `[DONE]`。
4. 实现只负责分派的 `createProvider`。

**验收**

- [ ] 不新增 `openai（兼容端点）` 第三种 protocol。
- [ ] 官方与兼容服务都通过 `protocol: openai` + `base_url` 表达。
- [ ] 工厂未知协议路径有防御性错误，即使配置层已拦截。

**验证**

```text
pnpm test -- tests/llm/openai.test.ts tests/llm/client.test.ts
pnpm typecheck
```

---

### T7. 实现紧凑 TUI 布局与基础组件

**依赖**：T1、T2、T3

**目标**

先完成可阅读的静态界面组件，不接真实网络请求。

**文件**

- `src/tui/header.tsx`
- `src/tui/provider-select.tsx`
- `src/tui/chat-view.tsx`
- `src/tui/activity.tsx`
- `src/tui/status-bar.tsx`
- `src/tui/sanitize-terminal.ts`
- `tests/tui/layout.test.tsx`

**先写测试**

- Header 首次以三行双栏布局展示固定猫头 ASCII，以及版本、`protocol · model`、工作目录；空间不足时隐藏猫头并降级为三行纯文本信息。
- Provider 列表支持上下键和 Enter。
- 历史消息按 `You` / `QiCode` 分组显示。
- hidden thinking 永远不出现在渲染结果中。
- 流式正文为纯文本，完成正文走 Markdown 渲染。
- usage 缺失时显示 `-`。
- 窄列宽下组件不依赖固定宽度。
- 用户或模型文本中的 ANSI、OSC 和危险控制字符不会进入渲染输出。

**实施步骤**

1. 实现一次性紧凑 Header：左栏严格使用 ` /\_/\`、`( o.o )`、` > ^ <` 三行猫头，上、下两行右移一格；右栏依次为 `QiCode v<version>`、`protocol · model`、工作目录。使用 Ink 横向布局和列间距，不用尾随空格硬拼；窄终端或高度不足时隐藏猫头并纵向显示三行信息。
2. 实现 Provider 选择列表。
3. 区分已完成历史和当前动态消息。
4. 实现请求活动状态、耗时和单行 StatusBar。
5. 只使用少量语义颜色，保证无颜色环境仍可阅读。
6. 在 Ink/Markdown 解析前清理终端控制序列，同时保留正常换行和制表符。

**验收**

- [ ] 页面信息顺序与 `spec.md` 的布局示意一致。
- [ ] 不实现命令面板、文件建议或工具消息样式。
- [ ] 历史区不会重复显示已经提交的消息。

**验证**

```text
pnpm test -- tests/tui/layout.test.tsx
pnpm typecheck
```

---

### T8. 实现输入组件与对话状态机

**依赖**：T3、T5、T6、T7

**目标**

连接输入、会话、Provider 事件和 TUI，形成完整的单进程多轮对话。

**文件**

- `src/tui/input-box.tsx`
- `src/tui/app.tsx`
- `src/prompt/system-prompt.ts`
- `tests/tui/app.test.tsx`

**先写测试**

- Enter 提交非空消息，空消息不提交；本阶段不实现键盘换行。
- waiting/streaming 时不允许第二次提交。
- 文本 delta 实时追加，done 后提交为助手消息。
- thinking 事件保存为 hidden block，不渲染。
- 中途错误保留用户消息和已接收正文，并重新启用输入。
- `/exit` 直接退出；第一次 Ctrl+C 中止当前请求并显示提示，1.5 秒内第二次 Ctrl+C 才退出。
- 第二轮 Provider 请求包含第一轮历史。
- 请求超时或取消后会清理计时器和网络流。

**实施步骤**

1. 实现受控输入框和光标位置；Enter 提交，不实现终端兼容性不稳定的键盘换行。
2. 实现最小系统提示词，只包含身份、日期和工作目录等当前阶段信息。
3. 在 `App` 中实现 `selecting/chat` 与 `idle/waiting/streaming/failed` 状态。
4. 聚合正文、thinking、signature、usage 和耗时。
5. 完成或失败后清理计时器、AbortController 和动态状态。
6. 设置统一请求超时；用户取消与超时共享同一清理路径，但展示不同结果。

**验收**

- [ ] 完整多轮流程只通过统一 Provider 接口运行。
- [ ] 一次只能存在一个进行中的请求。
- [ ] 错误后无需重启程序即可继续发送。
- [ ] 不持久化消息历史。

**验证**

```text
pnpm test -- tests/tui/app.test.tsx
pnpm typecheck
```

## 5. 检查点 B：完整离线流程

- [ ] 使用 fake Provider 完成两轮流式对话测试。
- [ ] thinking 隐藏与跨轮保存测试通过。
- [ ] 请求失败和部分响应保留测试通过。
- [ ] `pnpm test`、`pnpm typecheck`、`pnpm build` 全部通过。

---

### T9. 实现 CLI 入口和配置示例

**依赖**：T2、T8

**目标**

从真实命令行参数启动应用，并确保所有退出路径恢复终端。

**文件**

- `src/main.tsx`
- `config.example.yaml`
- `README.md`
- `tests/cli/main.test.ts`

**先写测试**

- 默认先读取当前工作目录下 `.QiCode/config.yaml`，不存在时回退到用户主目录 `.QiCode/config.yaml`。
- `--config <path>` 能覆盖默认路径。
- 未知或缺值参数返回可读错误。
- 配置失败以非零状态退出且无堆栈噪声。
- 入口向 App 传入已解析配置，不传入原始 API Key 文本以外的数据副本。

**实施步骤**

1. 解析首期唯一参数 `--config`。
2. 加载配置后启动 Ink。
3. 注册退出与异常清理，恢复光标和输入模式。
4. 提供两种协议的无真实密钥示例。
5. README 只记录安装、配置、开发、构建和运行命令。

**验收**

- [ ] `pnpm dev -- --config <path>` 可启动源码模式。
- [ ] `pnpm build && pnpm start -- --config <path>` 可启动构建模式。
- [ ] 示例与文档中不存在可用 Key。
- [ ] README 全部使用 pnpm 命令。

**验证**

```text
pnpm test -- tests/cli/main.test.ts
pnpm typecheck
pnpm build
```

---

### T10. 集成验收与质量检查

**依赖**：T1-T9

**目标**

用本地模拟服务和真实 Provider 完成最终证据收集，不新增功能。

**自动验证**

1. 本地 HTTP server 模拟 Anthropic SSE：文本、thinking、signature、usage、异常和中断。
2. 本地 HTTP server 模拟 OpenAI SSE：文本、usage、`[DONE]`、无 usage 兼容响应和异常。
3. 完整执行：

```text
pnpm typecheck
pnpm test
pnpm build
pnpm run start -- --config <test-config>
pnpm audit --prod
```

**手工验证**

1. 单 Provider 启动直接进入对话。
2. 多 Provider 启动可选择。
3. Anthropic `thinking: true` 完成至少两轮对话，界面不显示思考内容。
4. OpenAI 官方或兼容端点完成至少两轮对话。
5. 错误 Key、限流或模拟断流后，TUI 能继续使用。
6. Enter 提交、`/exit` 和 `Ctrl+C` 正常。
7. 在窄终端下检查换行、输入框和状态栏可读性。
8. 退出后光标与终端输入恢复正常。

**最终审查**

- [ ] 没有 Bun 命令、Bun 类型、`bun.lock` 或 Bun shebang 残留。
- [ ] `pnpm-lock.yaml` 已提交并与 `package.json` 一致。
- [ ] `packageManager` 精确固定为经过验证的 pnpm 版本。
- [ ] 没有 SDK、命令面板、MCP、tool use 等未使用依赖或代码。
- [ ] 没有 API Key、真实配置或敏感错误体进入版本库。
- [ ] 依赖审计没有未处理的高危、可达运行时问题，安装脚本经过审查。
- [ ] `spec.md` 每个验收项都有自动或手工证据。
- [ ] 所有实现文件均在本阶段目录结构内，未提前开发 Coding Agent 能力。

## 6. 依赖顺序

```text
T1
├─ T2 ───────────────┐
├─ T3 ─┬─ T4 ─┬─ T5 ├─ T8 ─ T9 ─ T10
│      │      └─ T6 ┘
│      └─────────────┐
└──────────────── T7 ┘
```

推荐顺序：

```text
T1 -> T2 -> T3 -> T4 -> Checkpoint A
   -> T5 -> T6 -> T7 -> T8 -> Checkpoint B
   -> T9 -> T10
```

## 7. 学习文档任务

代码、测试和真实端到端验证完成后，按 `check.md` 生成并验证第一章学习文档。

## 8. 开发开始条件

只有同时满足以下条件才从 T1 开始：

- [ ] 用户明确说“开发”。
- [ ] `spec.md` 的范围和交互没有未决问题。
- [ ] `plan.md` 的 Provider、SSE、thinking 和 TUI 方案已认可。
- [ ] 当前三份文档没有互相矛盾的字段、命令或验收标准。
