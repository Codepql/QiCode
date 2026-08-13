# QiCode

> A terminal-first AI coding agent built with TypeScript.

QiCode 是一个面向终端的 AI Coding Agent。它使用统一 Provider 接口接入 Anthropic 与 OpenAI 协议，通过 SSE 流式输出，并逐步提供文件读取、代码搜索、文件编辑和命令执行能力。

> [!WARNING]
> QiCode 仍处于早期开发阶段，接口、行为和目录结构都可能变化。项目已提供权限确认（人在回路）、工作区路径沙箱与危险命令拦截，但它们是启发式防线而非完备保证：危险命令黑名单无法穷尽所有风险，Bash 类工具不走路径沙箱，切换到 manual（全放行）模式请自行承担风险。请避免在包含重要数据的仓库中运行。

## Features

- **Terminal UI** - 基于 Ink 的交互式终端对话界面。
- **Multi-provider** - 支持 Anthropic Messages API 与 OpenAI Chat Completions API/兼容端点。
- **Streaming** - 使用 SSE 实时输出模型回复。
- **Conversation history** - 在当前进程内维护多轮对话上下文。
- **Extended thinking** - 支持 Anthropic extended thinking，并在后续请求中保留必要的 signature。
- **Built-in tools** - 提供 `ReadFile`、`WriteFile`、`EditFile`、`Bash`、`Glob`、`Grep`。
- **Tool calling / Agent Loop** - 支持两种 Provider 的流式工具调用解析、工具结果回灌与多轮 Agent Loop（最大轮数、取消）。

## Demo

```text
You
读取 README.md，并用三句话总结。

● ReadFile README.md
✓ ReadFile README.md
1       # QiCode
...

QiCode
QiCode 是一个基于 TypeScript 的终端 AI Coding Agent ...
```

## Requirements

- Node.js 22 LTS 或更高版本
- pnpm 10.14.0 或更高版本
- Anthropic 或 OpenAI 兼容 API 的有效密钥

## Installation

QiCode 当前以源码方式运行，尚未发布到 npm。

```bash
git clone <your-fork-or-repository-url>
cd QiCode
pnpm install
```

## Configuration

QiCode 按以下顺序查找配置：

1. `<project>/.QiCode/config.yaml`
2. `~/.QiCode/config.yaml`

也可以显式指定配置文件：

```bash
pnpm dev -- --config path/to/config.yaml
```

创建 `.QiCode/config.yaml`：

```yaml
providers:
  - name: claude
    protocol: anthropic
    model: claude-sonnet-5
    base_url: https://api.anthropic.com
    api_key: ${ANTHROPIC_API_KEY}
    thinking: true

  - name: openai
    protocol: openai
    model: gpt-5.5
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}
```

`protocol` 只能是 `anthropic` 或 `openai`。OpenAI 兼容服务同样使用 `openai`，通过 `base_url` 区分。

建议将 API Key 放进环境变量，而不是写入配置文件。`.QiCode/config.yaml` 已被 `.gitignore` 忽略，不要提交真实密钥。

## Usage

启动开发版：

```bash
pnpm dev
```

选择 Provider 后直接输入问题。以下任务适合第一次体验：

```text
读取 README.md，并用三句话总结。
```

```text
在 src 目录中搜索 buildSystemPrompt 的定义。
```

```text
列出 src/llm 目录中的 TypeScript 文件。
```

退出时输入 `/exit`，或在两秒内连续按两次 `Ctrl+C`。

## Built-in Tools

| Tool | Description |
| --- | --- |
| `ReadFile` | 读取文本文件，可指定起始行和最大行数。 |
| `Glob` | 使用 Glob 模式查找文件。 |
| `Grep` | 使用正则表达式搜索文件内容。 |
| `WriteFile` | 创建或覆盖文本文件。 |
| `EditFile` | 精确替换文件中已有的文本。 |
| `Bash` | 在当前平台 Shell 中执行命令。 |

Agent 以多轮方式运行：模型可连续发起多批工具调用，工具结果回灌后继续推理，直到给出最终回答或达到最大轮数（默认 20）。权限系统在工具执行前拦截：安全只读命令自动放行、危险命令硬拦截、写文件/命令默认弹窗请求确认；支持 default / Accept Edits / Plan / manual 四档权限模式（Shift+Tab 或 `/permission mode <name>` 切换）。

## Architecture

```text
User Input
  -> Ink App
  -> Agent
  -> Provider (Anthropic / OpenAI)
  -> SSE stream
  -> Tool call (optional)
  -> ToolRegistry -> Tool execution
  -> Conversation history
  -> Final streamed response
```

```text
src/
  agent/          # 多轮 Agent Loop 与工具执行器
  permissions/    # 权限流水线：危险命令、路径沙箱、规则引擎、模式矩阵
  config/         # YAML 配置加载与校验
  conversation/   # 对话、thinking、工具调用和工具结果
  prompt/         # 系统提示词与工具规则
  llm/             # Provider 契约、SSE、Anthropic、OpenAI
  tools/          # 内置工具与注册中心
  tui/            # Ink 终端界面
```

## Development

```bash
pnpm typecheck    # TypeScript 类型检查
pnpm test         # 运行测试
pnpm build        # 构建到 dist/
pnpm start        # 运行构建结果
```

如果 Windows PowerShell 阻止执行 `pnpm.ps1`，可以使用：

```powershell
pnpm.cmd dev
```

## Roadmap

- [x] 流式终端对话、Provider 抽象与多轮历史
- [x] 本地工具、工具调用协议与单轮工具闭环
- [x] 多轮 Agent Loop、最大轮数与取消策略
- [x] 模块化 Prompt 和环境上下文
- [x] 权限确认、路径沙箱和危险命令控制
- [ ] MCP、上下文压缩、记忆、Slash Commands、Skills、Hooks
- [ ] SubAgent、Worktree 与 Team Agent

完整的章节规划位于 [docs/plan](docs/plan/README.md)。

## Contributing

欢迎提交 Issue 和 Pull Request。提交前请确保：

```bash
pnpm typecheck
pnpm test
pnpm build
```

请勿提交 API Key、`.QiCode/config.yaml`、构建产物或与当前任务无关的格式化修改。

## License

项目计划采用 MIT License。正式公开发布前会补充 `LICENSE` 文件。
