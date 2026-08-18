# 第十一章开发前理解：Hooks

## 先看一个完整例子

先不要记 Hook 的定义。假设你不希望 Agent 修改 `.env` 文件。

没有 Hook 时，流程是：

```text
你：帮我修改 .env
模型：调用 WriteFile
程序：弹出权限确认，或者真的写入文件
```

加上一条 Hook 后，你写下的规则是：

```yaml
当 Agent 准备写文件时，
如果文件是 .env，
就拒绝这次写入，并告诉模型原因。
```

它运行起来是：

```text
你：帮我修改 .env
  -> 模型决定调用 WriteFile
  -> 程序正准备执行 WriteFile
  -> Hook 发现“目标是 .env”
  -> Hook 阻止 WriteFile
  -> 模型收到“该文件受保护，不能修改”
  -> 文件没有被改动
```

这条“在某个时刻自动检查并处理”的规则，就是 Hook。

## Hook 到底由什么组成

把上面的例子拆开，只有三件事：

```text
事件：什么时候检查？
条件：什么情况下命中？
动作：命中后做什么？
```

在 `.env` 例子中：

| 组成 | 人话 | 例子 |
| --- | --- | --- |
| event | Agent 走到哪一步了 | “准备执行工具” |
| condition | 这条规则该不该生效 | “工具要写的是 `.env`” |
| action | 生效后要做什么 | “拒绝并说明原因” |

所以 Hook 不是模型主动调用的工具，而是程序自动检查的“如果……就……”规则：

```text
当【事件】发生时，
如果【条件】成立，
就执行【动作】。
```

条件也可以没有。例如“每次模型回答前，都提醒它使用中文”：

```text
当模型请求即将发送时，
不需要额外条件，
就注入“请使用中文回答”。
```

## Hook 和普通 if 有什么区别

你可能会问：这不就是 `if` 吗？本质上是，但位置不同。

```text
普通 if：开发者把规则写死在 Agent 代码里。
Hook：用户把规则写在配置里，Agent 到固定位置时统一检查。
```

这样以后想加“写完文件自动格式化”“工具失败时通知本地服务”时，不用继续往 `Agent.run()` 塞新的 `if`。

## Hook、工具、Skill 的区别

```text
工具：模型主动选择“我要读文件 / 写文件 / 跑命令”。
Skill：告诉模型“遇到这种任务，应该怎样使用工具”。
Hook：程序自动检查“现在这个时刻，是否需要额外规则”。
```

例如：

```text
Skill：审查代码时先读 diff，再查相关文件。
工具：ReadFile、Grep。
Hook：任何人准备写 .env 前，都必须阻止。
```

Hook 的特点是**被动触发**：用户不能像 `/review` 一样直接执行它；Agent 走到配置指定的位置时，它才会自动发生。

## 为什么需要 Hooks

前十章已经解决了模型调用、工具、权限、MCP、上下文、命令和 Skill，但还缺少一种能力：**当 Agent 运行到某个固定时刻时，自动执行一条预先配置好的规则。**

例如：

- 每次请求模型前，临时提醒“请使用中文回答”。
- 写文件前检查路径，命中保护目录就阻止执行。
- 工具完成后，在后台运行格式化或记录日志。
- Agent 本轮任务结束后，通知本地服务。

如果继续把这些需求写成 `Agent.run()` 里的 `if`，Agent 会越来越难读。Hook 的目标是把它们统一描述成：

```text
什么时候发生（event）
  + 满足什么条件（condition）
  + 执行什么动作（action）
```

## Hook、Skill 和权限不是一回事

| 能力 | 解决的问题 | 能否作为安全边界 |
| --- | --- | --- |
| Skill | 告诉模型完成任务的方法和工具范围 | 只能收窄工具，正文仍是不可信 Prompt |
| PermissionChecker | 判断一次真实工具调用能否执行 | 是，最终执行必须经过它 |
| Hook | 在生命周期事件发生时自动响应 | 不是放权机制，只能增加动作或进一步拒绝 |

最重要的规则是：**Hook 不能绕过第五章权限链。**

一个 `pre_tool_use` Hook 可以在权限检查之前拒绝工具，但不能把原本被 PermissionChecker 拒绝的工具改成允许。命令和 HTTP Hook 自己也有副作用，同样必须接受权限检查。

## 一条 Hook 如何工作

```yaml
hooks:
  - id: protect-env
    event: pre_tool_use
    condition: file_path =* "**/.env"
    reject: true
    action:
      type: prompt
      prompt: "受保护的环境配置不能修改"
```

运行链是：

```text
模型请求 WriteFile
  -> Agent 先确认该工具没有被 Skill 隐藏
  -> HookEngine 收到 pre_tool_use
  -> 条件匹配 .env
  -> Hook 返回 reject + 原因
  -> Agent 生成错误 ToolResult 回灌模型
  -> 不进入 PermissionChecker
  -> 不执行 WriteFile
```

这里的 Hook 是额外的拒绝层，不是 PermissionChecker 的替代品。

## 生命周期里的“会话”和“轮次”

原规划的命名容易误解。当前代码中：

- 一个 `App` 实例代表整个 TUI 进程会话。
- 每次用户提交都会新建一个 `Agent`，调用一次 `Agent.run()`。
- 一次 `Agent.run()` 内可能经历多次模型请求：模型请求工具、工具结果回灌、模型继续回答。

因此本章即使保留 `session_start`、`turn_start` 等外部事件名，也必须按真实含义理解：

| 事件 | 当前项目中的准确含义 |
| --- | --- |
| `session_start` / `session_end` | 一次 `Agent.run()` 开始和结束，不是 TUI 进程启动和退出 |
| `turn_start` / `turn_end` | Agent 循环的一次 iteration 开始和结束 |
| `pre_send` / `post_receive` | 一次模型请求发送前和完整响应接收后 |
| `pre_tool_use` / `post_tool_use` | 单个工具执行前和结果形成后 |
| `shutdown` | 只保留类型，本章不接入进程退出 |

## Hook 输出如何进入模型上下文

第十章已经证明，把 reminder 反复写进 Conversation 会不断增加 token。本章不应重新犯这个问题。

HookEngine 可以保存尚未消费的通知，但 Agent 在请求模型时只把它们组装成**本次请求的临时 reminder**：

```text
Hook 输出进入有上限的通知队列
  -> 下一次模型请求前 drain
  -> 与 Skill reminder 一起临时装配
  -> 发给 Provider
  -> 不持久化重复副本到主 Conversation
```

同步 prompt Hook 在当前模型请求前产生的内容应立即生效；异步 Hook 来不及赶上当前请求时，留到下一次可消费的请求。

## 为什么 Hook 风险比 Skill 更高

Skill 主要影响模型决策，而 Hook 还可以直接运行命令或发送 HTTP 请求。外来 Hook 配置应视为可执行代码：

- Prompt 动作可能包含恶意指令。
- Command 动作可能修改文件或执行系统命令。
- HTTP 动作可能访问内网或把数据发送出去。
- HTTP 响应和命令输出仍是不可信文本，不能当成系统事实。

所以本章必须复用已有安全能力：PermissionChecker、超时、取消、输出上限、路径策略，以及第十章安装器中的公网地址判断。不能再写一套较弱的网络校验。

## 本章完成后应该理解什么

你不需要背完所有事件代码，先掌握四个目标：

1. HookEngine 只负责匹配规则、维护 once 状态和通知队列，不拥有 React 状态。
2. Agent 负责在准确生命周期位置派发事件，并保证 Hook 不能扩大权限。
3. App 只持有一个共享 HookEngine，使多次 `Agent.run()` 共用 once 和异步通知状态。
4. 有副作用的动作必须通过受控执行器，Prompt 和远程响应都不能被当成安全边界。

面试时可以概括为：

> 我为 Agent 增加了声明式生命周期 Hook。引擎负责事件匹配和状态，Agent 负责准确挂载点；pre-tool Hook 只能在权限检查前进一步拒绝，命令与 HTTP 动作仍经过权限、安全网络和资源上限控制，Hook 输出通过临时 reminder 回流，避免污染持久会话和重复消耗 token。
