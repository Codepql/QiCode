# 第十一章开发分割：Hook 生命周期系统

> 依据：`docs/plan/11-hooks/`，并按第十章验收后的真实代码调整。本文件只规划，不开始源码开发。

## 开发基线修正

原规划存在以下过时或互相冲突的内容，实施时以本文件为准：

| 原规划 | 当前事实与修正 |
| --- | --- |
| 修改 `src/config/config.ts` | 该文件不存在；实际文件是 `src/config/types.ts` 与 `src/config/load-config.ts` |
| 配置目录使用 `.qicode` | 项目已统一为 `.QiCode` |
| `AppConfig` 含 `mcp_servers` | MCP 已迁移到独立 `.QiCode/mcp-config/`，Hooks 不得重新绑定 MCP 配置 |
| App 显示 `role: system` 消息 | Conversation 只有 user/assistant；配置警告应走 TUI notice，不伪造模型消息 |
| 每轮 `addSystemReminder` 持久写 Hook 输出 | 改为请求级临时 reminder，避免重复 SOP 和 token 累积 |
| `session_start` 表示整个进程会话 | 当前一个 Agent 对应一次用户提交；该事件准确语义是一次 `Agent.run()` 的开始 |
| turn_start Hook 先入队、下一轮才消费 | 同步 prompt 必须在当前请求生效；派发后再 drain 并装配本次请求 |
| 通知队列和输出不设上限 | 必须设置单条和总量上限，防止 Hook 把上下文与内存撑爆 |
| command/http 可直接执行 | 两类动作都有副作用，必须经过 PermissionChecker 和受控执行器 |
| HTTP 单独实现地址检查 | 应提取并复用第十章公网地址与受限下载策略，避免两套安全标准 |
| agent action 本章直接运行 | 第十二章才实现通用 SubAgent；本章只保留注入接口和明确的未注册错误 |

## 总体依赖顺序

```text
阶段 1 配置契约
  -> 阶段 2 条件表达式与校验
  -> 阶段 3 纯 HookEngine
  -> 阶段 4 受控 Command 动作
  -> 阶段 5 受限 HTTP 动作
  -> 阶段 6 Agent 生命周期与工具拦截
  -> 阶段 7 App / main 接入
  -> 阶段 8 最终验收与学习交付
```

阶段 1 到阶段 7 不创建、不运行 `*.test.*`。每阶段只运行 `pnpm.cmd typecheck` 和 `git diff --check`；项目当前没有 lint/prettier script，不编造不存在的命令。阶段 8 才集中创建测试并运行全量验收。

## 第 1 阶段：配置契约与三层加载

**背景目标：** 先让 Hooks 成为合法配置，但不执行任何 Hook。配置层只负责保存输入与合并顺序，语义错误留给 Hook 校验器聚合处理。

**主要文件：**

- 修改 `src/config/types.ts`：增加 Hook 输入类型，`AppConfig` 增加 `hooks`，不加入 MCP 字段。
- 修改 `src/config/load-config.ts`：允许根字段 `hooks`，三层配置按用户、项目、项目本地顺序 append。
- 修改 `src/main.tsx`：无 `--config` 时使用已有 `loadConfigLayers()`；显式路径仍只加载指定文件。

**核心语义：**

- 路径固定为 `~/.QiCode/config.yaml`、`<workDir>/.QiCode/config.yaml`、`<workDir>/.QiCode/config.local.yaml`。
- providers 保持后层有效配置覆盖，hooks 采用数组追加，不按 id 静默覆盖。
- YAML 无法解析、Provider 缺失等基础配置错误仍可阻止启动；单条 Hook 的 event/action/condition 错误不在这里抛出。
- 加载结果必须复制数组，不能让后续运行时修改配置对象。

**阶段完成标志：** 类型检查通过；从代码可以明确看出 providers 与 hooks 使用不同合并语义，MCP 配置没有被重新并入。

**阶段总结重点：** 为什么配置加载与 Hook 语义校验必须分层，以及为什么 `--config` 与默认三层加载不能混为一谈。

## 第 2 阶段：类型、条件表达式与聚合校验

**背景目标：** 在接触 Agent 前，把最容易出错的规则解析做成纯函数。输入相同就输出相同，后续容易断点和集中测试。

**主要文件：**

- 新建 `src/hooks/types.ts`：事件、动作、上下文、结果、诊断类型。
- 新建 `src/hooks/condition.ts`：条件解析与求值。
- 新建 `src/hooks/validate.ts`：把未知输入转成有效 Hook，并聚合诊断。

**核心语义：**

- 事件固定为 `session_start/session_end/turn_start/turn_end/pre_send/post_receive/pre_tool_use/post_tool_use/shutdown`。
- 条件支持 `==`、`!=`、`=~`、`=*`、原子取反、`&&`、`||`；不支持括号。
- glob 使用 Node 现有路径能力或一个受限转换器，不新增依赖；Windows 路径先归一化为 `/`。
- 条件长度、正则长度设置上限；非法正则返回不匹配，不让派发崩溃。
- 未传入字段返回空字符串；工具 args 只能按字段名读取并安全转字符串。
- 校验返回 `{ hooks, diagnostics }`；坏 Hook 被跳过，合法 Hook 继续保留。
- `reject && async`、缺少动作字段、非法事件和错误策略必须形成带索引/id 的诊断。

**阶段完成标志：** 条件和校验模块不导入 Agent、React、Provider 或文件系统；调用者可以拿到有效 Hook 与全部错误。

**阶段总结重点：** 为什么不用 `eval`，为什么条件语言故意不支持完整表达式语法树。

## 第 3 阶段：纯 HookEngine、once 与有界通知队列

**背景目标：** 建立 Hook 的状态中心，但暂时只实现无外部副作用的 prompt 动作和未注册 action handler 的错误，不接 Agent。

**主要文件：**

- 新建 `src/hooks/engine.ts`。
- 视职责增加 `src/hooks/index.ts` 作为稳定导出入口；若只是转发且没有价值则不建。

**核心状态：**

- 有效 Hook 列表：保持配置声明顺序。
- `firedOnce`：绑定 HookEngine 实例，不写磁盘；`/clear` 不重置，进程重启重置。
- notification queue：保存等待下一次模型请求消费的输出。
- `pendingTasks`：跟踪异步动作，完成后自动移除，避免 Promise 长期滞留。

**核心行为：**

- `fire(event, context)` 依次执行 event、once、condition 三层过滤。
- prompt 动作返回配置文本；agent 动作没有 runner 时返回明确失败，不能假装成功。
- `firePreToolHooks()` 只暴露 `{rejected, reason}`，命中 reject 后停止后续 Hook。
- 非 pre-tool 事件忽略 reject 信号，避免一个错误字段终止整个 Agent。
- 队列限制单条文本和总字节数，超限使用明确截断提示；HTTP/命令输出标记为不可信数据。
- 同步输出可供当前请求立即 drain；异步输出在完成后的下一次请求消费。

**阶段完成标志：** 可以仅用内存对象演示 event 匹配、once、顺序、reject break、异步占位和 drain 清空，不需要 Provider 或 TUI。

**阶段总结重点：** HookEngine 拥有哪些状态，为什么它必须由 App 共享而不能每次 `submit()` 新建。

## 第 4 阶段：受控 Command 动作

**背景目标：** Hook 可以运行命令，但不能因为它来自本地 YAML 就绕过权限、取消和资源限制。

**主要文件：**

- 修改 `src/tools/bash.ts`：提取或复用受控命令执行核心，允许内部调用传入最小环境变量与更小输出上限。
- 新建 `src/hooks/command-action.ts`：把 HookContext 转成命令执行请求。
- 修改 `src/hooks/engine.ts`：通过注入的 action handler 调用，不直接依赖 TUI。

**核心语义：**

- 权限名称使用明确的合成工具名，例如 `HookCommand`，category 为 `command`。
- 检查顺序为 Hook 条件命中 -> PermissionChecker -> 必要时用户 Ask -> 执行器。
- 异步 command 如果权限结果是 Ask，安全默认拒绝并把原因排入通知队列，不在后台突然弹审批框。
- 固定注入 `QICODE_HOOK_EVENT`、`QICODE_HOOK_TOOL`、`QICODE_HOOK_FILE`，同时继承必要的进程环境；不把完整 args 展开为环境变量。
- 支持 AbortSignal、固定超时、进程树终止和较小输出上限。
- `on_error` 的 ignore/fail/reject 只处理动作失败；reject 只有 pre-tool 路径会消费。

**阶段完成标志：** 命令动作复用一条受控执行链；代码中不存在第二份无超时的 `spawn(command)`。

**阶段总结重点：** Hook 命令为什么仍要走 PermissionChecker，以及 async + Ask 为什么必须安全拒绝。

## 第 5 阶段：受限 HTTP 动作

**背景目标：** 支持通知本地服务或公网 HTTPS，同时防止 Hook 成为访问本机敏感服务和云元数据的 SSRF 通道。

**主要文件：**

- 新建 `src/security/safe-fetch.ts`：从 `InstallSkillTool` 提取通用 URL、DNS、重定向、超时和响应上限策略。
- 修改 `src/skills/install-tool.ts`：改用通用安全请求能力，保持第十章行为不变。
- 新建 `src/hooks/http-action.ts`。
- 修改 `src/hooks/engine.ts`：接入注入式 HTTP handler。

**核心语义：**

- 允许明确的 loopback HTTP 用于本地通知；其它 HTTP 拒绝，外部目标必须 HTTPS。
- 每一跳重定向都重新校验协议和地址；任一 DNS 结果为私网/保留地址时拒绝。
- 请求体固定为 HookContext JSON，不支持任意模板、任意 headers 或 shell + curl 绕过。
- 固定总超时、重定向次数、请求/响应大小上限，响应按 UTF-8 不可信文本处理。
- HTTP 是 command 类副作用，继续经过 PermissionChecker；不因为目标是 localhost 就自动放权。
- 保留并记录 DNS 检查与实际连接之间的 TOCTOU 边界，不宣称完全消除 DNS rebinding。

**阶段完成标志：** InstallSkill 和 Hook HTTP 共用同一网络安全模块，没有复制一个更弱的 `isPublicAddress()`。

**阶段总结重点：** 为什么只检查 `https://` 不足以防 SSRF，为什么重定向的每一跳都要重新检查。

## 第 6 阶段：接入 Agent 生命周期与工具拦截

**背景目标：** 把引擎挂到真实执行链的准确位置，同时保持 `Agent.run()` 的线性结构，不改造成通用 EventBus。

**主要文件：**

- 修改 `src/agent/agent.ts`：增加 HookEngine/HookActionHost 注入和生命周期派发。
- 必要时小改 `src/conversation/conversation.ts`：只复用 `systemReminderMessage()`，不增加持久 Hook 消息 API。

**事件顺序：**

```text
Agent.run 开始 -> session_start
每个 iteration：
  manageContext
  -> turn_start
  -> pre_send
  -> drain Hook notifications
  -> 与 Skill reminder 一起临时装配
  -> Provider.stream
  -> post_receive
  -> 有工具时逐条：Skill filter -> pre_tool_use -> Permission -> execute -> post_tool_use
  -> ToolResult 写回
  -> turn_end
Agent.run 所有返回/异常 -> finally session_end
```

**核心语义：**

- `session_end` 必须放在 `finally`，覆盖正常完成、取消、上下文失败和异常。
- pre-tool Hook 只能拒绝，不能产生 Allow；它不能覆盖 Skill filter 或 PermissionChecker。
- Hook 拒绝生成普通错误 ToolResult 回灌模型，工具实现调用次数必须为 0。
- post-tool 对成功、失败、权限拒绝、Hook 拒绝是否触发必须固定一种语义；建议对所有“已形成 ToolResult”的调用触发，便于审计，并在总结中明确。
- Prompt/Hook 输出采用请求级临时 reminder，不进入 Session JSONL，不重复污染 Conversation。
- 异步 Hook 不阻塞当前 iteration，完成结果留给下一次可消费请求。

**阶段完成标志：** 能从函数名复述九个事件的挂载位置；Hook 拦截位于真实工具执行之前，并且权限链仍是最终边界。

**阶段总结重点：** `session_start`、`turn_start` 在本项目里分别对应什么，为什么 Hook 不应改造成全局事件总线。

## 第 7 阶段：App、main 与用户可见诊断

**背景目标：** 让一个 TUI 进程只持有一个 HookEngine，并把配置警告与权限询问接回现有界面。

**主要文件：**

- 修改 `src/tui/app.tsx`：接收 hooks，创建并共享 Hook runtime，复用现有 `requestToolPermission()`。
- 视 App 体积决定把组合逻辑放入现有 `src/tui/runtime.ts`，不再新增大量零碎文件。
- 修改 `src/main.tsx`：传入 hooks，不触碰独立 MCP 加载。

**核心语义：**

- HookEngine 按 App/workDir 生命周期创建一次，多次用户提交共享 once 与异步通知。
- Hook 配置诊断显示为本地 notice，不伪造 `role: system`，也不发送给模型。
- `/clear` 清空 Conversation，但不重建 HookEngine；`/resume` 是否保留 once 以“同一进程保留”为准。
- 工作目录变化时 Hook runtime 必须随之重建，不能继续执行旧目录配置。
- command/http 同步 Ask 复用现有权限弹窗；取消和请求超时要继续向 Hook 动作传播。
- 本章不新增 `/hooks` 命令，除非真实调试证明没有其它可见入口。

**阶段完成标志：** 正确/错误 Hook 配置都能进入 TUI；错误只影响对应 Hook，合法 Hook 和聊天功能继续工作。

**阶段总结重点：** 为什么 HookEngine 属于 App 级状态，以及配置告警为什么不应写进模型 Conversation。

## 第 8 阶段：集中测试、真实验收与学习交付

**背景目标：** 前七阶段只完成实现和轻量静态检查；本阶段才建立行为证据，并以实际结果决定第十一章能否结束。

**测试文件建议：**

- 新建 `tests/hooks/condition.test.ts`。
- 新建 `tests/hooks/engine.test.ts`。
- 新建 `tests/hooks/actions.test.ts`。
- 修改 `tests/config/load-config.test.ts`。
- 修改 `tests/agent/agent.test.ts`。
- 修改 `tests/tui/app.test.tsx`。

**自动化验收范围：**

- 三层配置 append、显式 `--config`、非法 Hook 聚合但合法项保留。
- 条件全部算子、左右结合、缺失字段、非法/过长正则、Windows 路径 glob。
- 顺序、once、reject break、非 pre-tool 不拦截、有界队列、异步完成和错误策略。
- command 权限 Allow/Deny/Ask、取消、超时、输出上限和环境变量最小化。
- HTTP loopback、外部 HTTPS、私网/IPv6、混合 DNS、重定向、超时和体积限制。
- 每个生命周期事件的准确顺序；所有退出路径都触发 session_end。
- pre-tool 拒绝不进入权限与工具执行；post-tool 语义固定。
- Hook reminder 每次请求至多一份、不写入 Conversation、不写入 Session JSONL。
- App 共享引擎、配置警告、本地权限弹窗和 workDir 重建。

**最终命令：**

```text
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd build
git diff --check
```

随后使用真实 Provider 做终端冒烟：prompt 当前请求生效、WriteFile 被 pre-tool 拦截、异步命令不阻塞、HTTP 本地通知可到达、取消后无后台悬挂任务。临时配置和日志不得进入提交。

验收通过后才创建：

- `docs/study/Debug/11-hooks/README.md`
- `docs/study-Interview/11-hooks/README.md`

文档必须使用最终函数名、真实行号和测试数字，并包含至少三个可复现故障实验。若任何 Critical/Required Review 问题未解决，本章不得标记完成。

## 本章明确不做

- 不实现 Hook 配置热更新、重试、优先级、依赖关系和括号表达式。
- 不让 Hook 修改 PermissionChecker 的 Allow/Deny 结果。
- 不允许通过 shell + curl 绕过 HTTP 安全策略。
- 不实现 `shutdown` 的真实进程信号挂载。
- 不实现通用 SubAgent；agent action 只保留注入接口，第十二章再接真实 runner。

- 不持久化 once 状态，不把 Hook 输出无限写入 Conversation 或磁盘日志。
