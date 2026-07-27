# QiCode 第10阶段完成检查：Skill 系统

> 状态：未执行。只有用户明确说“开发第 10 章”并完成实现后，才按本清单验证。
>
> 需求依据：`spec.md`；技术依据：`plan.md`；实施依据：`task.md`。

> 每一项通过运行代码或观察行为来验证。最后一节"端到端场景（终端实跑）"必须在真实终端里跑过；其它项靠 `pnpm test` 与 `pnpm typecheck` 自动覆盖。

## 实现完整性

- [ ] `src/skills/skill.ts` 导出 `SkillMeta` / `Skill` / `SkillHost` / `SkillForkHost`（验证：`pnpm typecheck`）
- [ ] `src/skills/catalog.ts` 导出 `SkillCatalog`，含 `load` / `get` / `list` / `has`（验证：`pnpm typecheck`，`pnpm exec tsx -e 'import {SkillCatalog} from "./src/skills/catalog.ts"; new SkillCatalog().load(".")'` 不报错）
- [ ] `src/skills/executor.ts` 导出 `runInline` / `runFork`（验证：`pnpm typecheck`）
- [ ] `src/skills/load-skill-tool.ts` 导出 `LoadSkillTool` 实现 `Tool` 接口（验证：`pnpm typecheck`）
- [ ] `src/skills/install-tool.ts` 导出 `InstallSkillTool` 实现 `Tool` 接口（验证：`pnpm typecheck`）
- [ ] `src/tools/types.ts` 中 `Tool` 接口含 `system?: boolean`（验证：grep `system\\?:` 命中）
- [ ] `src/agent/agent.ts` 含 `activeSkills` 字段、`toolFilter` 私有字段、`buildActiveSkillsReminder` 私有函数（验证：grep 命中三处）
- [ ] `src/prompt/builder.ts` 的 `BuildOptions` 含 `skillSection?: string`，且 priority 90 槽位被启用（验证：grep `skillSection` 与 `priority: 90`）
- [ ] `src/commands/commands.ts` 的 `CommandType` 含 `"skill_fork"`；内置 `name: "skills"` 命令存在（验证：grep `"skill_fork"` 与 `name: "skills"`）
- [ ] `src/tui/app.tsx` 含 `wireSkillsToRegistry` 函数、`skillHostRef` / `skillCatalogRef` / `activeSkillsRef` / `toolFilterRef` 四个 ref（验证：grep）

## Skill 定义与解析

- [ ] 一个最简的合法 SKILL.md（仅 frontmatter `name` + body）能被 `SkillCatalog.load` 收录（验证：临时 fixture + `pnpm test`）
- [ ] frontmatter 缺 `name` 字段时 `parseSkillFile` 返回 null，对应 Skill 不进 catalog（验证：tests/skills.test.ts 扩展 / 临时手动）
- [ ] frontmatter 含 `allowed_tools: [Bash, ReadFile]` 时 `SkillMeta.allowedTools` 拿到 `["Bash", "ReadFile"]`（驼峰映射成立）
- [ ] frontmatter 含 `mode: fork` + `fork_context: recent` 时 `SkillMeta.mode === "fork"` 且 `forkContext === "recent"`

## Catalog 加载与覆盖

- [ ] 空 workDir + 空 HOME 启动后 `catalog.list()` 为空（验证：`pnpm test` 临时 mkdtempSync 验证 / 终端启动后 `/skills` 输出 `No skills found in .qicode/skills/.`）
- [ ] 用户级目录 `~/.qicode/skills/foo/` 与项目级 `/.qicode/skills/foo/` 同名 Skill 时，`catalog.get("foo")` 返回项目级版本（验证：手动 fixture 测试，比较 description）
- [ ] 单文件 Skill `/foo.md` 与目录 Skill `/foo/SKILL.md` 都能被收录（验证：手动 fixture + `catalog.has("foo")`）
- [ ] 编辑某个 SKILL.md 后不重启，下次 `catalog.get(name)` 取到的 body 是新内容（mtime 热重载，验证：单测 + 手动）
- [ ] 损坏的 SKILL.md（缺第二个 `---`）被 `parseSkillFile` 返回 null 静默跳过，不阻断其它 Skill 加载

## fail-fast 依赖检查

- [ ] `runInline` 在 `allowedTools` 含未注册工具时抛 `Error('skill "" declares allowed tool "" which is not registered')`（验证：`pnpm test -- tests/skills.test.ts` 可补一个用例覆盖；当前必过路径在 wireSkillsToRegistry 调用时延迟到 `/` 触发那刻）
- [ ] `LoadSkill` / `InstallSkill` 标记 `system = true`，工具过滤时 schema 仍出现在子集中（验证：单测构造 `toolFilter` 后用 `Agent.run` 内逻辑断言）

## Slash Command 自动注册

- [ ] `wireSkillsToRegistry` 把 inline 模式 Skill 注册为 `type: "prompt"`，fork 模式注册为 `type: "skill_fork"`（验证：单测可手动构造）
- [ ] 命令的 `description` 末尾带 ` [skill]` 标记（验证：`/help` 输出含 `[skill]`）
- [ ] 名字与已有命令冲突时跳过注册（验证：建一个 `name: help` 的 Skill，`/help` 仍为内置；catalog 中条目存在）
- [ ] `/skill  [args]` 输入被改写为 `/ [args]` 走标准命令路径（验证：终端实跑）

## 两阶段加载

- [ ] `buildActiveSkillsReminder(new Map())` 返回空字符串（验证：单测 + grep `if (active.size === 0) return ""`）
- [ ] `buildActiveSkillsReminder(map)` 非空时返回 `# Active Skills\n\n...\n\n## Active Skill: \n\n\n\n` 形式（验证：单测）
- [ ] `Agent.run` 每轮迭代调 `buildActiveSkillsReminder` 并通过 `conversation.addSystemReminder` 注入（验证：grep `buildActiveSkillsReminder` 在 `run()` 体内被调用）
- [ ] 工具 schema 过滤遵守 `toolFilter` + `system === true` 双条件（验证：grep `system === true` 在 agent.ts 中出现）

## LoadSkill 工具

- [ ] 调 `LoadSkill({name: ""})` 返回 `{ output: "Skill '' activated.\n\n", isError: false }` 且 `activeSkills` Map 包含该 name
- [ ] 调 `LoadSkill({name: ""})` 返回 isError 的 `Skill '' not found. Available skills: ...`
- [ ] 没有 `allowed_tools` 的 Skill 被 LoadSkill 激活后 `toolFilterRef.current` 仍为 null（不安装过滤器）
- [ ] 有 `allowed_tools` 的 Skill 被 LoadSkill 激活后 `toolFilterRef.current` 是函数，下一轮 `Agent.run` 工具 schema 收窄到 `allowed ∪ system`

## /clear

- [ ] `/clear` action 走 `setMessages([]) + new ConversationManager()`；当前实现下不显式重置 `activeSkillsRef` 与 `toolFilterRef`（验证：grep `case "clear"`，确认未触发 reset）

## Skill 执行器

- [ ] `runInline` 替换 `$ARGUMENTS` 占位符（验证：tests/skills.test.ts 第一个用例）
- [ ] `runInline` 无占位符时追加 `User Request: `（验证：tests/skills.test.ts 第二个用例）
- [ ] `runInline` 当 `allowedTools` 为空时不安装 toolFilter（验证：tests/skills.test.ts 第三个用例）
- [ ] `runFork` 按 `forkContext` 取 0 / 5 / 100 条父消息拼到 prompt 前（验证：可补单测 mock host）
- [ ] fork 模式跑完后主对话新增一条 `role: "assistant"` 消息（验证：终端实跑）

## InstallSkill

- [ ] 本地路径安装：`InstallSkillTool.execute({source: "/tmp/test-skill.md"})` 后 `<workDir>/.qicode/skills/<name>/SKILL.md` 存在且 `catalog.has(name)` 为 true（验证：tests/install-skill.test.ts 第一个用例）
- [ ] 缺失 source：`execute({source: "nope.md"})` 返回 `isError: true`（验证：tests/install-skill.test.ts 第二个用例）
- [ ] name 覆盖：`execute({source, name: "renamed"})` 写到 `.qicode/skills/renamed/SKILL.md`（验证：tests/install-skill.test.ts 第三个用例）
- [ ] HTTPS 安装覆盖超时、响应大小、重定向、非成功状态和原子写入；HTTP 明文来源被拒绝，远程安装经过权限确认。
- [ ] 安装完成后 `onInstalled` 回调被调；TUI 端立刻调用 `wireSkillsToRegistry` 让新命令可见（验证：终端实跑 install 后 `/skills` 立即列出）

## /skills 命令

- [ ] catalog 为空时 `/skills` 输出 `No skills found in .qicode/skills/.`
- [ ] catalog 非空时输出 `Available skills:` 后跟 `  / — ` 列表（验证：终端实跑）

## 编译与测试

- [ ] `pnpm typecheck` 无错误
- [ ] `pnpm test` 全部通过（含 tests/skills.test.ts 三例与 tests/install-skill.test.ts 三例）
- [ ] `pnpm dev` 能启动 TUI 不报错

## 端到端场景

> 在终端里启动 qicode，按下面流程一步步操作；每步附"观察"项。

**前置**：

- `cd . && pnpm install && pnpm dev`
- 准备两个测试 Skill：
  - `~/.qicode/skills/echoer/echoer.md`（单文件 inline）：

    ```
    ---
    name: echoer
    description: 把用户输入按 SOP 回显
    allowed_tools: [Bash]
    ---
    Run `echo $ARGUMENTS` and report stdout.
    ```

  - `/.qicode/skills/reviewer/SKILL.md`（目录 fork）：

    ```
    ---
    name: reviewer
    description: 对当前 git diff 给出客观审查
    mode: fork
    fork_context: none
    allowed_tools: [Bash, ReadFile, Grep]
    ---
    Run `git diff` and report concrete findings.
    ```

**步骤**：

1. **启动与就绪**
   - 操作：进程启动
   - 观察：TUI 主面板出现，状态栏底部含 "Type a message and press Enter..."；无类型/运行时错误

2. **`/help`**
   - 操作：键入 `/help` 回车
   - 观察：输出含内置命令 + `/skills` 行 + `/echoer ... [skill]` + `/reviewer ... [skill]`

3. **`/skills`**
   - 操作：键入 `/skills` 回车
   - 观察：首行 `Available skills:`，两行 `  /echoer — 把用户输入按 SOP 回显` / `  /reviewer — 对当前 git diff 给出客观审查`

4. **inline 模式 `/echoer hello`**
   - 操作：键入 `/echoer hello` 回车
   - 观察：UI 显示 user 消息（含 `Run \`echo hello\` and report stdout.`），LLM 调 Bash 工具 echo 出 `hello`；`/status` 显示 `Skills: 2`

5. **fork 模式 `/reviewer`**
   - 操作：在主对话先说 "I'm reviewing my diff now."，再键入 `/reviewer`
   - 观察：UI 显示 `Running skill "reviewer" in fork mode…`；之后追加一条 assistant 消息（含审查报告）；主 conversation 没有用户 SOP 文本，只有最终 assistant 文本

6. **意图触发 LoadSkill**
   - 操作：键入自然语言 "帮我把 README 里所有 echo 操作整理一下"（让 LLM 想到调 echoer）
   - 观察：LLM 调 `LoadSkill({name: "echoer"})`，工具结果 `Skill 'echoer' activated. ...`；下一轮迭代 conversation 中能通过 `addSystemReminder` 看到 `# Active Skills` 块（用 debug 日志或 `/status` 间接验证）

7. **`/skill echoer hello world` 短句**
   - 操作：键入 `/skill echoer hello world` 回车
   - 观察：被改写为 `/echoer hello world`，行为与第 4 步一致

8. **`InstallSkill` 安装第三方 Skill**
   - 操作：先 `echo '---\nname: greeter\ndescription: greet\n---\nSay hi to $ARGUMENTS.' > /tmp/greeter.md`；切到 qicode 输入 "把 /tmp/greeter.md 装成 skill"
   - 观察：LLM 调 `InstallSkill({source: "/tmp/greeter.md"})`，工具返回 `Skill 'greeter' installed ...`；`/skills` 立即多出 `  /greeter — greet`；`/greeter alice` 可调用

9. **热重载**
   - 操作：在另一个终端 `echo '---\nname: echoer\ndescription: 新描述\n---\nNew body $ARGUMENTS' >> ~/.qicode/skills/echoer/echoer.md`（追加内容并触发 mtime 更新），然后在 qicode 中再次说自然语言让 LLM `LoadSkill({name:"echoer"})`
   - 观察：工具返回的 body 反映新内容

10. **`/clear` 与退出**
    - 操作：键入 `/clear` 回车，再键入 `/quit`
    - 观察：对话清空、新 sessionId；`/quit` 后进程优雅退出

## 验收报告模板

```
## 验收报告

### 通过
- [ ] `pnpm typecheck` 无错误：tsc 0 error
- [ ] `pnpm test` — tests/skills.test.ts 3 pass, tests/install-skill.test.ts 3 pass
- [ ] /skills 输出两条 Skill ...
- ...

### 未通过
- [ ] 第 X 项 — 预期：...，实际：...，修复方案：...

### 端到端
- [ ] 启动与就绪 — 结果：TUI 正常加载
- [ ] /help — 结果：含 [skill] 行
- [ ] /skills — 结果：echoer + reviewer
- ...（按上面 10 步逐条列出）
```
## 学习与面试验收

- [ ] 学习文档来自最终代码，文件名、函数名和行号均已核对。
- [ ] 文档能从入口讲到本章核心行为完成，包含关键状态变化。
- [ ] 高频问题包含设计原因、替代方案、当前局限和继续追问。
- [ ] 调试步骤已实际走通，断点与观察变量有效。
- [ ] 至少三个故障实验可重复，并解释症状、根因和定位路径。
- [ ] 学习者完成一个独立小改动并通过测试与 Review。

## 完成准则

只有本清单适用项目全部完成，且 `spec.md` 每项验收标准都有自动化或手工证据时，第 10 章才可标记完成。
