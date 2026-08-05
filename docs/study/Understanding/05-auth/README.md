# 05-Permissions 开发前认识与理解

> 本文用于第 05 章开发前学习。规划描述目标，源码决定真实起点；本章中的 auth 指 authorization（授权），不是用户登录认证。

## 一、为什么 Agent 必须有权限系统

前四章已经让 QiCode 具备完整的自主执行链：模型能输出工具调用，Agent 能解析、执行并把结果回灌给模型。这也是风险出现的位置。

模型输出 `WriteFile` 或 `Bash` 只是一个“执行意图”，不应该自动等于“系统已经授权”。LLM 会误判、提示词会被绕过、用户输入和仓库内容也可能诱导模型做危险操作。因此权限系统必须位于模型和真实副作用之间。

```text
LLM 决定想做什么 != 系统允许它做什么
```

第四章的 Prompt 规则属于软约束；第五章的 PermissionChecker 属于执行前的代码约束。前者提高模型做对的概率，后者决定错误意图能否真正落地。

## 二、本章真正解决什么

本章不是做一个 `if (dangerous) return false`，而是建立一条有优先级、能解释、可交互的决策链：

```text
tool_use(toolName, args)
        |
        v
提取工具类别和关键内容
        |
        v
PermissionChecker.check()
  | allow      | deny          | ask
  v            v               v
执行工具     回灌错误结果     等待用户批准
```

三个结果的含义：

- `allow`：某一层明确允许，工具可以进入执行器。
- `deny`：某一层明确拒绝，工具不能执行，但 Agent Loop 可以继续。
- `ask`：自动策略无法决定，需要人在回路作最终选择。

关键点是 `ask` 不是错误，而是一种暂停中的正常状态。

## 三、当前代码已经有什么

当前 `src/permissions/checker.ts` 只有：

```ts
type AgentMode = "default" | "plan";
allows(category): boolean;
```

它已经在两处生效：

1. `toolDefinitions()` 在请求 LLM 前过滤工具，Plan Mode 只让模型看到 read 工具。
2. `executeBatch()` 在真正执行前再次调用 `allows()`，防止模型或历史消息绕过工具暴露。

这说明第四章已经建立了一个正确的基本观念：**工具可见性和工具执行权限不是同一层，执行前仍需复查。**

第五章需要补齐的能力是：

- boolean 升级为 `allow | deny | ask`。
- 两种模式升级为四种模式。
- 加入命令策略、路径沙箱和配置规则。
- Ask 时让 Agent 暂停并等待用户决定。
- Deny 时保持 conversation 中 tool use/result 配对合法。

## 四、一条完整的用户流程

以默认模式下模型想执行 `git commit -m "x"` 为例：

```text
用户提出任务
  |
  v
Agent 请求 Provider
  |
  v
模型返回 Bash({ command: "git commit -m x" })
  |
  v
Agent 找到 Bash.category === "command"
  |
  v
PermissionChecker.check("Bash", "command", args)
  |
  +-- 不是安全只读命令
  +-- 未命中硬黑名单
  +-- 命令工具不走路径沙箱
  +-- 没有会话/配置规则
  +-- default + command => ask
  |
  v
Agent await onPermissionRequest(...)
  |
  v
App 渲染 PermissionDialog
  |
  +-- 允许本次 -> 执行
  +-- 永久允许 -> 写规则后执行
  +-- 拒绝     -> 生成错误 tool_result
  |
  v
结果进入 Conversation，Agent 继续下一轮
```

这个流程中 Provider 不参与权限判断。无论 Anthropic 还是 OpenAI，进入 Agent 后都是统一的 `tool_use`，所以权限策略天然跨协议复用。

## 五、为什么要分层并短路

权限层不是权重投票，而是按顺序寻找第一个有决定权的规则。

```text
高优先级、不可绕过
  危险命令 / 路径越界
          |
          v
用户显式策略
  会话规则 / YAML 规则
          |
          v
低优先级默认值
  权限模式矩阵
```

例如用户配置了 `Bash(*) allow`，也不应该放过 `rm -rf /`。所以危险命令必须在配置规则之前返回 Deny。`bypassPermissions` 也只是最低层的自动 Allow，不是关闭整个安全系统。

面试时可以把它表述为：

> 我把权限实现为 ordered policy pipeline。硬安全策略先决策，用户规则居中，模式矩阵只做兜底；每层返回带 reason 的 Allow、Deny 或 Ask，命中后立即短路。

## 六、六个核心模块的四问

| 模块 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
| --- | --- | --- | --- | --- |
| `PermissionChecker` | 编排所有权限层并返回 Decision | Agent | 命令策略、沙箱、规则引擎、模式矩阵 | 给 Agent 一个协议无关的唯一入口 |
| 命令策略 | 快速允许只读命令、硬拒绝高危命令 | PermissionChecker | 正则和字符串边界判断 | Bash 能产生最大副作用，需要独立策略 |
| `PathSandbox` | 判断文件目标是否位于允许根内 | PermissionChecker | Node path/fs | 阻止路径穿越和符号链接逃逸 |
| `RuleEngine` | 读取、匹配并写入权限规则 | PermissionChecker | YAML、文件系统、glob | 支持用户细粒度覆盖默认模式 |
| `Agent` 权限接入 | 在执行前检查并处理三态结果 | App | PermissionChecker、StreamingExecutor | 这里是真正的副作用边界 |
| `PermissionDialog` | 收集人的批准决定 | App | Ink 输入事件 | 把 Ask 变成可以恢复的异步流程 |

## 七、最容易混淆的五组概念

### 1. 提示词约束 vs 权限约束

提示词告诉模型“不要做”；权限代码保证即使模型仍然请求，也不会直接执行。安全不能只靠 Prompt。

### 2. 工具可见性 vs 执行授权

不把工具发给模型可以减少误调用，但不是安全边界。历史消息、协议异常或未来代码改动仍可能产生工具调用，所以执行前必须重新授权。

### 3. Deny vs 抛异常

Deny 是某个工具调用的业务结果，应回灌为 `isError: true` 的 `tool_result`。抛异常会中断整个 Agent Loop，模型也失去根据拒绝原因改路径的机会。

### 4. Ask vs 阻塞进程

Agent 只是在 `await Promise`，Node 事件循环仍运行，Ink 仍能接收键盘输入。Dialog 最终调用 resolver，Agent 从原位置继续。

### 5. 模式 vs 规则

模式是“没有更具体结论时怎么办”；规则是对某个工具和内容的显式决定。模式不应该覆盖黑名单、沙箱或显式 deny。

## 八、路径沙箱要理解到什么程度

最常见的错误实现是：

```ts
absolutePath.startsWith(workDir)
```

它至少有三个问题：

1. `/project-evil` 也以 `/project` 开头。
2. `project/link` 可能是指向 `/etc` 的符号链接。
3. 新文件尚不存在，不能直接对目标调用 `realpath`。

更可靠的思路是：

```text
用户路径
  -> resolve 成绝对路径
  -> relative 判断是否越过根目录
  -> 找到最近存在祖先
  -> realpath 验证祖先没有通过软链逃逸
  -> 对不存在的叶子路径恢复拼接
```

但要诚实说明：本章的路径沙箱只覆盖文件类工具。Bash 内部可以访问任意路径，静态解析 shell 命令无法形成完整文件系统沙箱。

## 九、规则引擎要理解到什么程度

规则可以抽象成：

```text
ToolName(pattern) -> allow | deny
```

例如：

```yaml
- rule: "Bash(git status*)"
  effect: allow
- rule: "WriteFile(src/generated/*)"
  effect: deny
```

需要同时回答四个问题：

1. 从哪几个文件读取？
2. 文件之间谁优先？
3. 同一个文件多条命中时谁优先？
4. 文件损坏时是崩溃、放行还是回到默认策略？

本项目选择损坏配置视为空规则，然后进入后续模式兜底。它避免程序崩溃，也不会因为解析失败自动扩大成全局 Allow。

“永久允许”也不是保存一个 boolean，而是把本次工具和内容转换成一条范围受控的规则。规则范围过宽会成为持久化的安全漏洞。

## 十、HITL Promise 桥是本章最值得讲的 Agent 设计

Agent 层不能直接渲染 React 组件，TUI 也不应该执行权限算法。二者通过 Promise 回调解耦：

```text
Agent                          App / Ink
  |                               |
  | onPermissionRequest(...)      |
  |------------------------------>|
  | await Promise                 | setState 显示 Dialog
  |                               | 用户按键
  |                               | resolve(action)
  |<------------------------------|
  | 根据 action 继续              |
```

这里的关键状态有两个：

- `permissionRequest`：决定界面显示什么。
- `permissionResolveRef`：决定用户选择后唤醒哪个 Promise。

必须处理的异常路径包括 Esc、任务取消、组件卸载和重复请求，否则 Agent 可能永远停在 await，或者旧 resolver 被错误调用。

## 十一、原规划中需要带着判断力看的地方

### Plan 文件语义

第四章当前约定 `.QiCode/plan.md`，并明确 Plan Mode 不编辑文件。第五章旧文档又写 `.qicode/plans/` 和计划文件写豁免，两者不一致。开发时不能用 `includes(".qicode/plans/")` 草率兼容，应先确定唯一语义并复用 `getPlanPath()`。

### 安全命令列表

`python -c`、`node -e`、`npm run` 和 `pnpm dev` 都能运行任意代码，不属于只读安全命令。面试时不要声称“有元字符过滤就安全”，因为没有元字符也能执行危险逻辑。

### 黑名单的边界

危险命令正则只能阻止已知模式，是启发式防线，不是完整 shell sandbox。编码、别名、脚本文件和间接调用都可能绕过字符串黑名单。因此高风险命令仍需要 Ask、操作系统隔离或更强执行环境。

## 十二、开发前建议掌握的 12 个问题

1. 为什么模型产生 tool call 不等于获得执行授权？
2. 为什么权限检查必须紧贴 `executor.submit()`？
3. Allow、Deny、Ask 分别代表什么？
4. 为什么模式矩阵只能做兜底，不能覆盖硬 Deny？
5. 为什么 bypass/manual 仍不能绕过危险命令和路径沙箱？
6. 为什么安全命令前缀匹配必须先检查 shell 元字符？
7. 为什么 `startsWith(workDir)` 不是可靠的路径沙箱？
8. 为什么损坏 YAML 应降级为空规则，而不是全 Allow？
9. 永久允许为什么要保存具体 pattern，而不是整个工具？
10. Deny 为什么要变成结构化 tool result 而不是异常？
11. Agent 如何在等待批准时保持 TUI 可交互？
12. 为什么 Provider 不应该知道权限模式？

## 十三、推荐学习顺序

1. 先读本文，能画出 `tool_use -> check -> allow/deny/ask`。
2. 阅读当前 `src/permissions/checker.ts`，理解第四章占位实现的边界。
3. 阅读 `src/agent/agent.ts` 的 `toolDefinitions()`、`executeTools()`、`executeBatch()`，找到真实执行边界。
4. 第 1-5 次开发时只学习纯权限决策，不先看 Ink UI。
5. 第 6 次跟踪一次 Deny 如何保持 tool use/result 配对。
6. 第 7 次再学习 Promise resolver 如何把 Agent 和 TUI 接起来。
7. 最后用三种场景复述：安全命令自动允许、危险命令硬拒绝、普通写操作等待用户批准。

## 通过标准

你能不看代码说明以下内容：

- 为什么 Prompt 不是安全边界；
- 权限流水线为什么按优先级短路；
- Deny 为什么回灌而不是终止 Loop；
- Ask 如何通过 Promise 暂停和恢复 Agent；
- 路径沙箱、命令黑名单和规则引擎各自能防什么、不能防什么；
- bypassPermissions 为什么也不等于关闭所有安全检查。

达到这个标准后，第五章写到简历上才不是“做了权限弹窗”，而是“在 Agent 工具执行边界实现了可解释的分层授权与人在回路控制”。
