# QiCode 第一阶段规格：LLM 终端对话

> 状态：规划中，等待用户明确说“开发”后才进入实现。
>
> 本文只定义“做什么”和“如何验收”。技术方案见 `plan.md`，执行步骤见 `task.md`。

## 1. 项目背景

QiCode 是一个使用 TypeScript 从零构建的命令行 AI Agent 编程终端，产品方向类似 Claude Code。

第一阶段只建立最小对话闭环：用户启动 QiCode，进入交互式终端界面，输入问题后由
LLM 流式返回回复，并在当前进程内保留多轮对话上下文。

这一阶段不是 Coding Agent，不包含工具调用、文件操作或代码修改能力。

## 2. 阶段目标

完成后，用户应能：

1. 使用 pnpm 安装、运行、测试和构建 QiCode。
2. 从 YAML 配置中选择 Anthropic 或 OpenAI 协议的模型。
3. 在 TUI 中连续发送多轮消息。
4. 实时看到基于 SSE 的流式回复，而不是等待完整响应。
5. 在 Anthropic 协议下启用 Claude extended thinking。
6. 在请求失败后看到可理解的错误，并继续使用当前会话。

## 3. 本阶段范围

### 3.1 包含

- TypeScript + Node.js 命令行应用。
- pnpm 包管理与脚本工作流。
- Anthropic Messages API。
- OpenAI Chat Completions API，以及通过 `base_url` 接入兼容服务。
- 统一 Provider 接口。
- SSE 流式解析。
- Claude extended thinking。
- 当前进程内的多轮对话上下文。
- Provider 启动选择、对话展示、输入框、状态栏和错误提示。
- `/exit` 与 `Ctrl+C` 安全退出。

### 3.2 不包含

- Tool use / function calling。
- 文件读取、搜索、写入或代码编辑。
- Shell 命令执行。
- MCP、Hooks、Skills 或插件系统。
- 权限确认与沙箱。
- 长期记忆、会话持久化与会话恢复。
- 上下文压缩、自动摘要与自动重试。
- 图片、音频等多模态输入。
- 运行中切换 Provider 或模型。
- 完整 slash command 系统；本阶段仅支持 `/exit`。

## 4. 用户流程

```text
启动 QiCode
  -> 加载并校验 YAML 配置
  -> 一个 Provider：直接进入对话
     多个 Provider：先选择本次会话使用的 Provider
  -> 用户输入并提交消息
  -> QiCode 携带完整历史发起 SSE 请求
  -> TUI 实时显示正文增量
  -> 响应结束后保存助手消息
  -> 用户继续下一轮，或退出程序
```

## 5. 配置规格

### 5.1 配置位置

- 配置查找优先级：`--config <path>` → `<workDir>/.QiCode/config.yaml` → `~/.QiCode/config.yaml`。
- Windows 全局路径示例：`C:\Users\<用户名>\.QiCode\config.yaml`。
- 可通过启动参数 `--config <path>` 指定其他配置文件。
- 仓库只提交示例配置，不提交真实 API Key。

### 5.2 YAML 结构

YAML 顶层使用 `providers` 数组。每个 Provider 只包含以下六个配置字段：

| 字段 | 必填 | 类型 | 说明 |
|---|---:|---|---|
| `name` | 是 | string | 供应商配置的唯一标识，用于启动选择和界面展示 |
| `protocol` | 是 | enum | 仅允许 `anthropic` 或 `openai` |
| `model` | 是 | string | 请求使用的模型名称 |
| `base_url` | 是 | string | API 基础地址，可包含 `/v1` 等基础路径，但不包含最终资源名 |
| `api_key` | 是 | string | API Key，或 `${ENV_NAME}` 形式的环境变量引用 |
| `thinking` | 否 | boolean | 是否启用 Claude extended thinking，默认 `false` |

约束：

- `name` 在同一配置中不得重复。
- `thinking: true` 仅允许用于 `anthropic`；用于 `openai` 时视为配置错误。
- `api_key` 使用 `${ENV_NAME}` 时，环境变量不存在或为空应在启动期报错。
- 不自动打印、记录或持久化解析后的 API Key。

示例：

```yaml
providers:
  - name: claude-main
    protocol: anthropic
    model: claude-sonnet
    base_url: https://api.anthropic.com
    api_key: ${ANTHROPIC_API_KEY}
    thinking: true

  - name: openai-main
    protocol: openai
    model: gpt-model
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}
```

## 6. 功能需求

### F1. 配置加载与校验

- 启动时读取 YAML，并逐项校验六个 Provider 字段。
- 配置文件缺失、YAML 非法、Provider 为空、字段缺失或值非法时，输出简洁错误并以非零状态退出。
- 错误信息应指出具体 Provider 和字段，但不得包含 API Key。

### F2. Provider 选择

- 只有一个 Provider 时直接进入对话。
- 有多个 Provider 时显示可键盘操作的选择列表。
- 列表展示 `name`、`protocol` 和 `model`，使用方向键移动，Enter 确认。
- Provider 在会话启动后固定，不在当前会话中切换。

### F3. 统一 Provider 接口

- TUI 和会话层只依赖统一接口，不直接依赖 Anthropic 或 OpenAI 的响应结构。
- Provider 以异步事件流返回正文增量、隐藏思考增量、用量和结束事件。
- 新增其他协议时，不应要求修改对话状态和主要 TUI 流程。

### F4. Anthropic 协议

- 使用 Anthropic Messages API 的流式模式。
- 请求携带系统提示词和完整对话历史。
- `thinking: true` 时发送 extended thinking 参数。
- 思考内容不在 TUI 中展示，但思考块及签名必须保存在内存历史中，以保证后续 Anthropic 多轮请求有效。

### F5. OpenAI 协议

- 使用 OpenAI Chat Completions API 的流式模式。
- `base_url` 可指向 OpenAI 官方地址或兼容端点。
- 请求携带系统提示词和完整的文本对话历史。
- OpenAI Provider 不接收 Claude thinking 参数。

### F6. SSE 流式处理

- 直接消费 HTTP 响应流，并按 SSE 事件边界解析。
- 正确处理拆包、粘包、CRLF、多个 `data:` 行、空行和结束标记。
- 收到正文增量后立即更新界面，不等待完整响应。
- 用户退出或取消时，通过 `AbortController` 终止正在进行的请求。

### F7. 多轮会话

- 用户消息提交后立即加入当前会话历史。
- 助手响应完成后加入历史；若流式响应中断，已经收到的正文也应保留。
- 每轮请求携带此前完整历史。
- 退出进程后历史清空，不落盘。

### F8. 输入交互

- Enter 提交非空消息。由于部分终端无法可靠区分 `Shift+Enter`，本阶段不提供键盘换行快捷键。
- 流式响应期间禁用再次提交。
- 空消息不发送。
- `/exit` 可直接退出；`Ctrl+C` 采用二次确认，第一次取消当前请求并提示，1.5 秒内再次按下才退出。

### F9. TUI 展示

界面采用紧凑布局。首次进入对话时显示固定的三行猫头 ASCII 品牌标识：

```text
          /\_/\    QiCode v0.1.0
         ( o.o )   anthropic · claude-sonnet
          > ^ <    E:\workspace
------------------------------------------------------------


>解释一下 SSE。

·SSE 是一种服务器向客户端持续推送事件的方式……

Thinking... (2.4s | token :520(变化) k)

╭─ Message ────────────────────────────────────────────────╮
│ 输入内容                                                  │
╰──────────────────────────────────────────────────────────╯
anthropic · claude-sonnet · in 120 · out 64 · Ctrl+C exit
```

布局规则：

- 猫头 ASCII 与顶部信息组成三行双栏 Header：左侧严格使用 ` /\_/\`、`( o.o )`、` > ^ <` 三行，即上、下两行相对中间行右移一格；右侧依次显示版本、`protocol · model` 和工作目录。
- Header 只在进入对话时显示一次，不进入对话历史，也不在每轮响应后重复渲染。
- 猫头只使用 ASCII 字符，不增加身体、边框或其他装饰；右侧信息不能依赖尾随空格对齐。终端过窄或可用高度不足时隐藏猫头，改为三行纯文本信息。
- 历史区按 `You` / `QiCode` 分组，角色和正文分行，避免长前缀挤压内容。
- 流式期间正文按纯文本即时展示；完成后使用终端 Markdown 样式定型。
- 用户输入和模型输出在进入终端渲染前移除危险控制字符，避免内容伪造终端状态。
- 输入框固定在当前动态区域底部，提示 `Enter send`，状态栏保持单行。
- 窄终端自动换行，不依赖固定宽度。

### F10. 状态与用量

- 请求发出后立即显示进行中状态和耗时。
- 有用量数据时显示输入、输出 token；无数据时显示 `-`，不得伪造数值。
- 响应完成后移除 Spinner，不持续占用动态区域。

### F11. 错误恢复

- 对鉴权失败、限流、网络错误、无效响应、上下文过长和主动取消进行分类。
- 错误显示在对话区，并保留用户输入。
- 除启动配置错误外，单轮请求失败不应导致程序退出。
- 原始响应内容与请求头不得直接暴露 API Key。

### F12. 终端恢复

- 正常退出、`Ctrl+C` 和未捕获异常退出时均尽力恢复光标和输入模式。
- 不残留持续运行的计时器或网络连接。

## 7. 非功能需求

| 编号 | 要求 |
|---|---|
| N1 | 支持 Node.js 22 LTS，使用 pnpm 管理依赖 |
| N2 | TypeScript 开启严格模式，生产代码不使用无理由的 `any` |
| N3 | 网络请求和 SSE 解析不得阻塞 TUI 输入与渲染 |
| N4 | Provider 差异限制在 `src/llm/` 内 |
| N5 | API Key 不进入日志、错误详情、测试快照或版本库 |
| N6 | 核心逻辑可单元测试，协议适配可用本地模拟流测试 |
| N7 | 常见 Windows Terminal、PowerShell、macOS Terminal 和 Linux 终端可正常使用 |
| N8 | 网络请求具有明确超时和取消路径，SSE 单事件大小有上限，避免无限等待或无界内存增长 |

## 8. 验收标准

- [ ] `pnpm install`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部成功。
- [ ] `pnpm dev` 能进入 TUI，构建后 `pnpm start` 能运行同一应用。
- [ ] 合法单 Provider 配置直接进入对话，多 Provider 配置可选择。
- [ ] 六个配置字段按本规格校验，错误信息不泄露 API Key。
- [ ] Anthropic 与 OpenAI 均能以 SSE 方式逐步显示正文。
- [ ] Anthropic extended thinking 可开启，思考内容不显示但能支持后续多轮请求。
- [ ] 第二轮提问能够使用第一轮上下文。
- [ ] 流式中断时保留已接收正文，界面仍可继续下一轮。
- [ ] `/exit` 直接退出；第一次 `Ctrl+C` 只取消当前请求并提示，1.5 秒内第二次才退出，终端状态正常。
- [ ] TUI 在窄终端下仍可阅读，顶部、历史、输入和状态信息层次清楚。

## 9. 学习与面试交付

实现完成后必须根据真实代码生成问题导向学习文档，包含完整调用链、准确文件与行号、断点和观察变量、SSE/Provider/thinking 故障实验、高频面试问答和一个独立练习。

## 10. 开发门禁

在用户明确说“开发”之前：

- 只允许继续讨论或修改 `spec.md`、`plan.md`、`task.md`。
- 不创建 `package.json`、源码、测试、配置模板或锁文件。
- 不安装依赖，不调用真实 LLM API。
