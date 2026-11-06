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

从 npm 安装 CLI：

```bash
npm install --global @coderpql/qicode
# 或
pnpm add --global @coderpql/qicode
```

### 1. 初始化全局配置

首次使用只需生成一次全局配置：

```bash
qicode init
```

初始化后会生成以下目录和文件；重复执行不会覆盖已有配置：

```text
~/.QiCode/
  config.yaml             # Provider 配置
  mcp-config/config.yaml  # MCP 配置
  skills/                 # 个人 Skill 目录
```

### 2. 填写配置

用编辑器打开命令输出的 `~/.QiCode/config.yaml` 路径，填写 API 地址、密钥和模型名称。Windows 下通常为 `C:\Users\<用户名>\.QiCode\config.yaml`：

```yaml
base_url: https://api.example.com/v1
token: your-api-token
model: your-model-name
```

以上值均为占位示例，请替换为你的服务配置。更多配置方式见下方 [Configuration](#configuration)。

### 3. 启动 QiCode

配置完成后，进入你要使用 QiCode 的任意项目目录运行：

```bash
qicode
```

## Configuration

QiCode 按以下顺序加载 Provider 配置，后加载文件中的 Provider 列表会覆盖前面的列表；不存在的文件会跳过：

1. `~/.QiCode/config.yaml`
2. `<project>/.QiCode/config.yaml`
3. `<project>/.QiCode/config.local.yaml`

也可以显式指定配置文件：

```bash
qicode --config path/to/config.yaml
```

`qicode init` 创建的 `~/.QiCode/config.yaml` 适用于所有项目，普通用户只需填写三个字段：

```yaml
base_url: https://api.example.com/v1
token: your-api-token
model: your-model-name
```

项目需要不同模型或凭据时，在项目目录执行：

```bash
qicode init --project
```

将生成的 `.QiCode/config.example.yaml` 复制为 `.QiCode/config.local.yaml`，填写该项目的 `base_url`、`token` 和 `model`，即可覆盖全局 Provider 配置。

`protocol` 默认是 `openai`，适用于 OpenAI Chat Completions 及兼容服务。需要 Anthropic 或多个 Provider 时，使用完整格式：

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

建议将 token 放进环境变量，通过 `${TOKEN_ENV_NAME}` 引用，而不是写入配置文件。不要提交 `config.local.yaml`。

## Skills and MCP

Skill 与 MCP 不放在 Provider 配置中，目录彼此独立：

```text
~/.QiCode/skills/                         # 所有项目可用的个人 Skill
<project>/.QiCode/skills/                 # 仅当前项目使用的 Skill
~/.QiCode/mcp-config/config.yaml          # 个人 MCP
<project>/.QiCode/mcp-config/config.yaml  # 项目共享 MCP
<project>/.QiCode/mcp-config/config.local.yaml # 私密 MCP token/headers
```

Skill 文件使用目录形式 `skills/<name>/SKILL.md`。MCP 配置使用 `mcp_servers` 数组；命令型 MCP 填 `command`/`args`，远程 MCP 填 `url`/`transport`。`config.local.yaml` 适合放 token、headers 和本机路径，不应提交到 Git。

## Usage

完成上述初始化和配置后，在项目目录启动已安装版本：

```bash
qicode
```

从源码开发：

```bash
pnpm install
pnpm dev init
```

在生成的 `~/.QiCode/config.yaml` 中填写配置后启动：

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

### 终端操作

| 操作 | 按键 |
| --- | --- |
| 发送 / 换行 | Enter / Ctrl+J；支持增强按键的终端也可用 Shift+Enter 或 Alt+Enter 换行 |
| 移动与编辑 | 方向键、Home/End、Ctrl+A/E、Ctrl+Left/Right、Ctrl+W/U/K |
| 浏览本次进程的输入历史 | 编辑器首/末显示行处按 ↑/↓，返回时保留未发送草稿 |
| 手动粘贴模式 | Alt+V（或终端允许时 Ctrl+V）切换；模式中 Enter 只换行，退出模式后 Enter 发送 |
| 展开 / 折叠长粘贴 | Ctrl+O；折叠块边界处 Backspace/Delete 可整块移除 |
| 翻阅聊天 / 回到最新 | PageUp/PageDown / Ctrl+End；Ctrl+Home 到开头，也支持鼠标滚轮 |
| 查看长通知 | Ctrl+N 展开，PageUp/PageDown 浏览，Esc 收起 |
| 团队面板 / 权限模式 | Ctrl+T / Shift+Tab |

多行粘贴会保留缩进，不自动发送；长粘贴显示折叠摘要，发送的仍是完整正文。粘贴内容按正文处理，不直接执行 Slash 命令。输入上限为 1 MiB UTF-8，超限保留原草稿并提示。

打开弹窗后，键盘只作用于该弹窗。聊天上翻后暂停跟随输出，Ctrl+End 恢复；鼠标捕获开启时可使用终端的 Shift+拖选操作选择复制。窗口小于 40×10 时保留草稿并暂停输入，恢复尺寸后继续编辑。

运行中可继续编辑并按 Enter 提交当前任务补充，在下一工具批次或模型请求边界生效；Alt+Q 取回最近一条未消费补充。Esc/Ctrl+C 可取消当前任务，已生效的修改保留。真实终端输入法和选择复制的兼容性验收状态见 [第一期实现记录](docs/Optimize-plan/terminal-ux/phase-1-implementation.md)。

第二期加入了命令实时输出与日志、编辑 diff、修改后的验证记录、结构化会话恢复和执行预算。默认总任务预算 15 分钟，模型响应空闲上限 120 秒，单命令默认 120 秒、可指定到 600 秒；权限等待暂停总任务计时。模型可用 Bash 的 `purpose: verification` 标记检查，验证失败会回到执行循环，最多 3 轮失败修复。代码改变后，旧验证记录不再作为当前通过证据。

可在现有配置中增加 `execution`，例如 `{ "taskTimeoutMs": 900000, "maxIterations": 80 }`；`model_capabilities` 按模型名配置 `{ "contextWindow": 128000, "maxOutput": 8192 }`。未配置模型能力时采用 32768 上下文窗口。完整实现范围和待验收项见 [第二期实现记录](docs/Optimize-plan/terminal-ux/phase-2-implementation.md)。

## Built-in Tools

### 会话与长期使用

常见的独立 `git diff` / `git log` / `git show` 查看命令自动放行，执行时禁用外部 diff、textconv 等辅助程序；复合命令仍按原权限处理。首次授权时可直接按 **T**，允许本次任务中的文件编辑和普通命令，任务结束失效，不落盘；已识别的发布、删除、外部操作、显式权限规则和结果未知操作单独处理。也可按 Y 仅允许本次调用、A 记住这条操作、N 拒绝，无需回车。`/permission mode acceptEdits` 自动允许工作区文件编辑；`/permission mode bypassPermissions` 允许普通工具连续执行，内置危险命令、路径边界和显式拒绝规则仍然生效。

`/resume` 搜索和预览会话，`/resume latest` 恢复最近会话，`/rename 标题` 命名，`/new` 新建。`/model` 选择已配置模型，运行中登记的切换在任务结束后生效。快捷入口为 Alt+S 会话、Alt+M 模型、Alt+T 任务、Alt+B 设置，`/hotkeys` 查看完整按键。

`/files` 或输入 `@路径` 后按 Tab 搜索文件，确认后引用路径而不自动注入整份正文；`/files remove 序号` 移除引用。`/tasks` 查看任务详情，Ctrl+X 取消所选任务。`/rewind` 先预览检查点，再选择文件或文件与对话的恢复范围。

`/settings` 保存项目级布局、显示和安全权限偏好，存储在 `.qicode/ui.json`；`/settings bind tasks alt+b` 可调整入口按键，冲突会拒绝保存。详细范围见 [第三期实现记录](docs/Optimize-plan/terminal-ux/phase-3-implementation.md)。

### 工具列表

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

第一轮生产化加固的行为变化、恢复方式与限制见 [生产化加固说明](docs/production/round-1.md)。

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

项目采用 MIT License，详见 [LICENSE](LICENSE)。
