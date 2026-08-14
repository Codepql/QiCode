# 第十章 Interview：如何讲 Skill 运行时

## 简历表述

我在终端 Agent 中实现了可发现的 Skill 运行时：支持用户级和项目级 Markdown SOP、项目覆盖、按需加载、动态 Slash 命令、工具白名单和隔离 Fork。Skill 的工具限制同时作用于 LLM 可见 Schema 与真实执行路径，避免模型幻觉调用绕过策略；远程或本地安装经过路径、软链接、重定向、体积和原子写入校验。

## 30 秒讲清架构

Skill 是“可配置的工作流约束”，不是新工具。`SkillCatalog` 负责把磁盘文件变成可信结构化对象；`executor` 负责把它激活为持续 reminder 和工具过滤器；`Agent` 在每次模型请求前临时生成一份 reminder，并在 Schema 层和执行层各检查一次；Fork Skill 则另起 Conversation 和 Registry，结果只展示给主界面、不写回主历史。这样既不会累积重复 SOP，也没有把配置层、策略层与执行层混在一个 `App.submit()` 里。

## 高频追问

### Skill 的 `allowed_tools` 和 Permission Mode 有什么关系？

它们是两道不同方向的门。Skill 白名单是“这个 SOP 最多能用什么”，收缩工具集合；PermissionChecker 是“当前安全模式是否允许这次调用”，决定是否执行或 Ask。最终权限是二者都允许，而不是 Skill 白名单覆盖权限模式。

### 为什么不能只在给 LLM 的 tools 列表里删掉不允许的工具？

Schema 只是引导，不是安全边界。模型、重放消息或第三方 Provider 都可能返回未声明的 tool call，所以 `Agent.executeBatch()` 还要在真正调用 `tool.execute()` 前拒绝被 Filter 隐藏的普通工具。这就是防御性双重校验。

### 为什么多个 Skill 的白名单取交集，而不是并集？

同时激活意味着同时承诺遵守两个 SOP。并集会让一个严格 Skill 被另一个宽松 Skill 放大权限；交集保证每个限制都仍然成立。没有声明白名单的 Skill 不参与交集，语义是“只提供流程，不额外限制”。

### Skill 文件为什么要有 catalog，而不是每次 `/name` 都读文件？

Catalog 集中处理发现规则、frontmatter 校验、用户/项目覆盖和 mtime 重载。命令、模型工具和 UI 都从同一个对象取 Skill，避免每个入口各自解析而语义漂移。`get()` 的 mtime 检查只针对已知 Skill，避免每个回合扫描整棵目录。

### `LoadSkill` 与 Slash 命令分别解决什么？

`/<name>` 是用户主动执行入口，`LoadSkill` 是模型发现工具后按需加载 Inline SOP 的入口；Inline 两条入口最终都调用 `runInline()`，因此工具存在性校验、激活状态和工具限制一致。Fork Skill 必须通过用户 Slash 命令进入隔离执行，`LoadSkill` 会明确拒绝，不能把 Fork SOP 偷偷激活到主 Agent。

### 为什么 Fork 不复用主 Conversation？

子任务经常包含试探、失败工具调用和中间结论。如果混入主 Conversation，主 Agent 会把它们当成历史事实，token 和上下文也会膨胀。Fork 新建 Conversation；主界面仅以 UI 消息显示最终输出，主会话仍保持用户真实对话。

### 为什么 Fork 要新建 Registry，还要跳过主会话的 system tools？

部分系统工具持有主 UI 或主会话的闭包状态。直接复用会让“隔离 Agent”仍能改主状态。Fork 复制普通工具，重建 `ToolSearch` 和本地 `LoadSkill`，用独立 `activeSkills`；文件工具仍在同一工作目录，所以文件改动仍受原有权限链和快照机制约束。

### 安装 Skill 时如何防止 SSRF 和路径穿越？

本地源先 `resolve`、`realpath` 并验证仍在 workDir 内，拒绝软链接与非普通文件；远程源只允许 HTTPS、无 URL 凭据，每跳重定向都重新检查解析地址为公网，限制 3 次跳转、15 秒和 512 KiB。写入使用技能根目录临时目录后 rename，避免半份文件成为可加载 Skill。

### 你会如何解释“一个 Skill 里提到工具，但项目没有这个名字”？

Skill 文本不是能力注册表。`runInline()` 在激活前检查 `allowed_tools` 是否都在 `ToolRegistry` 中；名字不匹配直接失败，避免模型收到无法兑现的 SOP。实际工程中应先读项目的 Tool Registry 或提供能力映射层；当前实现选择 fail-fast，而不是根据自然语言描述猜工具。

## 可以主动说出的边界

- HTTPS 地址在 DNS 校验与 `fetch` 建连之间仍存在理论上的 DNS rebinding 时间窗口；要达到更强保证，需要自定义连接器并将已校验 IP 与 TLS SNI/Host 绑定。
- 新增磁盘 Skill 当前需重启才能出现为 Slash 命令；已存在 Skill 的正文在 `get()` 时可按 mtime 重载。若需要真正热注册，应补 Catalog 变更事件与 CommandRegistry 的卸载/更新语义。
- Fork 是本章的 Skill 专用隔离执行，不是可调度、可并发、可递归的通用 SubAgent 框架；后者应在后续章节定义任务队列、取消传播和结果汇总。
- 自动化验收覆盖运行时边界，但真实 Provider 下的提示词质量、长任务稳定性和交互视觉仍需真人冒烟。

## 验收证据

本章最终执行 `pnpm.cmd test`，37 个测试文件、213 条测试全部通过；`pnpm.cmd typecheck`、`pnpm.cmd build` 和 `git diff --check` 均通过。测试新增了 Skill catalog、工具双重限制、临时 reminder、Inline/Fork 加载边界、HTTPS 安装安全和 Fork 隔离的回归覆盖，并修正既有测试对本机用户目录与 Windows 路径的错误假设。
