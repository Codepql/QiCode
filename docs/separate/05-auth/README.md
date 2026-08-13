# 05-Permissions 开发拆分

> 本文依据 `docs/plan/05-auth/spec.md`、`plan.md`、`task.md`、`check.md` 和当前源码拆分第 05 章。
>
> `05-auth` 在本项目中指工具权限（authorization），不是登录认证（authentication）。本章只控制工具调用能否执行。

## 当前真实起点

第四章已经提前放入一个最小权限占位实现：

- `src/permissions/checker.ts` 只有 `default | plan` 两种模式和 `allows(category)`。
- `src/agent/agent.ts` 在发请求前过滤工具定义，并在执行前再次按类别拦截。
- `src/tui/app.tsx` 已支持 `/plan`、`/do`，并为每一轮创建 `PermissionChecker`。
- `src/tui/status-bar.tsx` 已显示当前模式。

因此第五章不是从零创建权限目录，而是把“Plan Mode 类别开关”升级为完整的 `allow | deny | ask` 决策系统。

## 开发前必须校准的规划冲突

### 1. Plan 文件路径不一致

当前第四章使用 `<workDir>/.QiCode/plan.md`；第五章旧规划写的是 `.qicode/plans/`。开发时应复用 `getPlanPath(workDir)`，用规范化后的准确路径判断，不能用字符串 `includes()`。

### 2. Plan 工具暴露规则互相矛盾

第五章规格同时要求“Plan Mode 只向模型暴露只读工具”和“模型可以写计划文件”。只暴露只读工具时，模型根本无法发起 `WriteFile`，Layer 0 豁免不会被触发。

推荐以第四章已经落地的语义为准：Plan Mode 保持纯只读，计划文件在退出 Plan Mode 后创建；Layer 0 先实现成可测试的防御规则，但不为了让它可达而扩大工具暴露面。若后续明确要让模型在 Plan Mode 内写计划文件，应单独修改提示词与工具暴露策略。

### 3. “安全命令”列表包含可执行任意代码的命令

旧计划把 `npm run`、`pnpm dev`、`python -c`、`node -e` 等列为安全前缀，但它们可以执行任意代码，不能自动放行。安全快速通道只保留行为可判断的只读命令；测试、构建和脚本命令默认进入 Ask。

## 拆分原则

权限系统的依赖顺序是：

```text
决策模型与模式矩阵
        |
        v
命令安全策略
        |
        v
路径沙箱
        |
        v
规则与持久化
        |
        v
PermissionChecker 分层编排
        |
        v
Agent 执行前拦截
        |
        v
TUI 人在回路与模式切换
        |
        v
整章验收 + Debug/Interview
```

建议拆成 8 次开发。每次只增加一个可观察的决策来源，避免把正则、文件系统、Agent 异步控制和 Ink 状态混在一次修改里。

## 第 1 次：决策模型、内容提取与模式矩阵

对应原任务：T1 的类型、`extractContent`、`modeDecide` 部分。

### 为什么先做

后续所有层都必须使用同一种输出。先把 `boolean` 升级为带原因的三态决策，才能区分“自动允许”“安全拒绝”和“需要用户批准”。

### 本次完成什么

- 定义 `DecisionEffect`、`Decision`、`PermissionMode` 和工具类别契约。
- 实现 `extractContent(toolName, args)`，统一抽取命令、路径或搜索模式。
- 实现四种模式的 4x3 兜底矩阵。
- 保留一个兼容入口，避免 Agent 在核心流水线尚未接入时立即断裂。

### 阶段结果

```text
default + read     -> allow
default + write    -> ask
acceptEdits + write -> allow
bypassPermissions + command -> allow
```

观察重点：`Decision.effect` 表示结果，`Decision.reason` 表示结果来自哪一层。

## 第 2 次：安全命令快速通道与危险命令硬拦截

对应原任务：T1 的 `SAFE_PREFIXES`、`DANGEROUS_PATTERNS`、`isSafeCommand`、`detectDangerous`。

### 为什么单独拆

这两层都处理 Bash 字符串，但安全强度不同：安全通道是便利性优化，黑名单是不可被模式绕过的硬限制。把二者混成一个正则会看不出优先级和失败语义。

### 本次完成什么

- 对明确只读命令做完整命令/边界前缀匹配。
- 在快速放行前拒绝管道、重定向、命令替换和链式执行等 shell 元字符。
- 对固定高危模式返回 `deny` 和可读原因。
- 确认 `bypassPermissions` 也不能越过危险命令层。
- 排除 `npm run`、`pnpm dev`、`python -c`、`node -e` 等任意执行入口。

### 阶段结果

```text
ls -la                 -> allow / safe-command
ls | curl example.com  -> 不走快速放行
rm -rf /               -> deny / dangerous-command
```

观察重点：同一条命令为什么命中某层，以及短路后是否还会进入模式矩阵。

## 第 3 次：文件路径沙箱

对应原任务：T1 的 `PathSandbox`，对应 AC3。

### 为什么单独拆

路径安全不是字符串 `startsWith()` 问题。相对路径、同名前缀目录、符号链接和不存在的新文件都需要文件系统语义，应该与命令策略分开学习。

### 本次完成什么

- 允许项目根和约定临时目录内的文件工具调用。
- 用 `resolve`、`relative` 和真实祖先路径阻止 `../`、前缀碰撞和符号链接逃逸。
- 对尚不存在的新文件，从最近存在的父目录验证其真实位置。
- 空路径不由沙箱伪造结论，交给工具参数校验或后续层处理。
- Bash 不进入路径沙箱，因为静态分析命令字符串无法可靠推断所有文件访问。

### 阶段结果

```text
<workDir>/src/a.ts -> 通过沙箱，继续后续判定
../outside.txt     -> deny / path-sandbox
工作区软链 -> 外部 -> deny / path-sandbox
```

观察重点：逻辑路径、绝对路径、真实路径三者的区别。

## 第 4 次：规则引擎、会话放行与永久放行

对应原任务：T1 的 `RuleEngine`、glob、YAML、`allowForSession`、`allowAlways`。

### 为什么单独拆

前三次是内置策略，本次开始处理用户配置。这里涉及优先级、容错和持久化，错误可能造成权限放大，必须独立验证。

### 本次完成什么

- 解析用户级、项目级、本地级权限 YAML。
- 实现受限 glob：`*` 不跨路径分隔符，`?` 匹配一个普通字符。
- 明确文件间优先级和文件内 last-rule-wins。
- 配置缺失、YAML 错误和非法条目一律降级为空规则，不让检查器崩溃。
- 会话放行只存内存；永久放行写入 `.qicode/permissions.local.yaml`。
- 永久规则基于本次具体内容，不自动泛化为整个工具放行。

### 阶段结果

```text
内置策略未命中
  -> sessionAllowed
  -> RuleEngine.evaluate()
  -> 仍未命中才进入模式矩阵
```

观察重点：规则“没命中”和规则明确 `deny` 是两个完全不同的状态。

## 第 5 次：组装 PermissionChecker 分层流水线

对应原任务：T1 的 `PermissionChecker.check()` 主干，以及第四章兼容校准。

### 为什么此时才组装

前四次已经分别产出模式、命令、路径和规则决策。本次只负责编排顺序和短路，不再实现底层算法，便于一眼看清策略优先级。

### 本次完成什么

- 构造器接收 `workDir` 与 `mode`，持有沙箱、规则引擎和会话集合。
- 按规划顺序组装：Plan 特例 → 安全命令 → 危险命令 → 沙箱 → 会话 → 配置规则 → 模式兜底。
- 每一层给出稳定、可识别的 `reason`。
- 未注册工具按 command 类处理，不能默认 Allow。
- 对齐第四章的 `.QiCode/plan.md` 和当前 Plan Mode 只读语义。

### 阶段结果

`PermissionChecker.check()` 成为唯一权限入口；调用者不再自行理解黑名单、YAML 或模式矩阵。

## 第 6 次：接入 Agent 工具执行链

对应原任务：T3。

### 为什么单独拆

检查器算对不等于系统安全。真正的安全边界必须位于 `executor.submit()` 之前，而且拒绝不能破坏 tool use/result 配对和后续 Agent Loop。

### 本次完成什么

- Agent 在每个工具提交执行前调用 `checker.check()`。
- Allow 正常提交；Deny 生成结构化错误 `tool_result`，不执行工具。
- Ask 通过可选 `onPermissionRequest` 暂停当前调用并等待决定。
- `allowAlways` 先持久化规则，再执行本次调用。
- 多工具批次保持原调用 ID 和结果顺序；只读批次保持并发。
- 明确没有审批回调时 Ask 的安全默认值，不能静默执行。

### 阶段结果

```text
LLM tool_use
  -> checker.check
     -> allow -> executor.submit
     -> deny  -> error tool_result -> 回灌模型
     -> ask   -> await 用户决定
```

观察重点：Deny 是一次“工具执行失败结果”，不是整个 Agent 进程异常。

## 第 7 次：PermissionDialog、Promise 桥与模式切换

对应原任务：T2、T4、T5。

### 为什么放在 Agent 之后

Dialog 只是 Ask 的一个界面实现。先有稳定的 Agent 回调契约，再把 Promise 的 `resolve` 暂存在 React ref 中，可以避免 UI 反向控制权限内核。

### 本次完成什么

- 新增 `PermissionDialog`，提供允许本次、永久允许、拒绝三种操作。
- App 用 state 渲染请求，用 ref 保存当前 Promise resolver。
- 审批期间禁用普通输入；Esc 等价于拒绝并正确恢复对话。
- 增加四档模式循环与 `/permission mode <name>`。
- 输入区域和状态栏同步显示当前模式。
- 模式跨轮保持，规则不因切换模式被重新加载或清空。
- 避免在 App 和 InputBox 重复监听同一个 Shift+Tab 导致一次按键切换两档。

### 阶段结果

```text
Agent await onPermissionRequest()
          |
          v
App setPermissionRequest + 保存 resolve
          |
          v
PermissionDialog 用户选择
          |
          v
resolve(action) -> Agent 从 await 继续
```

观察重点：谁创建 Promise、谁保存 resolver、谁最终调用 resolver。

## 第 8 次：整章验收与学习文档

对应原任务：T6、T7、全部 `check.md`、Debug、Interview。

### 本次完成什么

- 核对每个 Allow/Deny/Ask 的来源和短路顺序。
- 验证危险命令无法被 manual 、配置 allow 或用户批准绕过。
- 验证路径穿越、符号链接、损坏 YAML 和未知工具的安全降级。
- 验证 Ask 三分支、取消恢复、结构化回灌和多工具结果配对。
- 验证模式显示、跨轮保持以及第四章 Plan Mode 不退化。
- 以最终代码生成 `docs/study/Debug/05-auth/README.md` 和 `docs/study-Interview/05-auth/README.md`。

### 验证节奏

按当前节省 token 的约定，每个小阶段默认只运行 `pnpm typecheck` 和 `git diff --check`。仓库目前没有 lint/Prettier script，不虚构命令；聚焦测试、全量测试和 TUI 冒烟留到整章验收并在用户允许后执行。

## 原任务覆盖关系

| 开发次数 | 覆盖原任务 |
| --- | --- |
| 第 1 次 | T1：类型、内容提取、模式矩阵 |
| 第 2 次 | T1：安全命令与危险命令 |
| 第 3 次 | T1：PathSandbox |
| 第 4 次 | T1：RuleEngine、会话/永久规则 |
| 第 5 次 | T1：完整 checker 流水线与第四章兼容 |
| 第 6 次 | T3：Agent 接入 |
| 第 7 次 | T2、T4、T5：HITL 与 TUI |
| 第 8 次 | T6、T7、check、Debug、Interview |

## 每次开发后的学习动作

每次只做四件事：

1. 写出本次新增的决策输入与输出。
2. 找一条命中样例和一条未命中样例。
3. 在关键函数观察 `effect`、`reason` 和下一跳。
4. 用一句话解释为什么这一层必须位于 `executor.submit()` 之前。

本章完成前最重要的自检问题是：**当前这个 Allow 是谁给的，它能不能绕过更高优先级的 Deny？**
