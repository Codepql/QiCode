# QiCode 第10阶段任务清单：Skill 系统

> 状态：未开始。只有用户明确说“开发第 10 章”后才执行。
>
> 前置章节：01-09。所有命令使用 pnpm；开发运行 `pnpm dev`，聚焦测试使用 `pnpm test -- <path>`，类型检查 `pnpm typecheck`，构建 `pnpm build`。
>
> 每个行为任务遵循测试先行，并在完成后记录真实实现位置和验证证据。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/skills/skill.ts` | `SkillMeta` / `Skill` / `SkillHost` / `SkillForkHost` 接口 |
| 新建 | `src/skills/catalog.ts` | `SkillCatalog` 类：扫描两层目录、按 mtime 热重载 |
| 新建 | `src/skills/executor.ts` | `runInline` / `runFork` / `assertAllowedToolsExist` |
| 新建 | `src/skills/load-skill-tool.ts` | `LoadSkillTool` 实现 `Tool` 接口 |
| 新建 | `src/skills/install-tool.ts` | `InstallSkillTool` 实现 `Tool` 接口 |
| 修改 | `src/tools/types.ts` | `Tool` 接口新增 `system?: boolean` 标记 |
| 修改 | `src/agent/agent.ts` | `AgentConfig.activeSkills` / `.toolFilter`；`run()` 每轮 reminder + 工具 schema 过滤 |
| 修改 | `src/prompt/builder.ts` | `BuildOptions.skillSection` 槽（priority 90） |
| 修改 | `src/commands/commands.ts` | `CommandType += "skill_fork"`；内置 `/skills` 命令 |
| 修改 | `src/tui/app.tsx` | refs + `skillHostRef` + `wireSkillsToRegistry` + `skill_fork` 分发 |
| 新建 | `tests/skills.test.ts` | `runInline` 单测：`$ARGUMENTS` / fallback / 工具过滤器 |
| 新建 | `tests/install-skill.test.ts` | `InstallSkillTool` 单测：本地路径、错误、`name` 覆盖 |

## T1: skills 类型定义

**文件：** `src/skills/skill.ts`

**依赖：** `src/tools/registry.ts`

**步骤：**

1. 定义 `SkillMeta`：`name`（必填）、`description`、`allowedTools?: string[]`、`mode?: "inline" | "fork"`、`model?: string`、`forkContext?: "full" | "recent" | "none"`
2. 定义 `Skill`：`meta` / `body` / `sourceDir` / `isDirectory`
3. 定义 `SkillHost`：`activateSkill(name, body)` / `setToolFilter(filter | null)` / `toolRegistry(): ToolRegistry`
4. 定义 `SkillForkHost extends SkillHost`：`runSubAgent(prompt, toolFilter?): Promise` / `snapshotParentMessages(count): string`
5. import 路径用 `.js` 后缀（ESM `"type": "module"` 要求）：`from "../tools/registry.js"`

**验证：** `pnpm typecheck` 通过。

## T2: SkillCatalog 扫描与热重载

**文件：** `src/skills/catalog.ts`

**依赖：** T1

**步骤：**

1. 引入 `readdirSync` / `readFileSync` / `existsSync` / `statSync`、`join`、`homedir`、`yaml`
2. 定义内部 `CatalogEntry`：`skill`、`filePath`、`loadedMtimeMs`
3. 定义 `SkillCatalog` 类，私有字段 `entries = new Map()`
4. `load(workDir: string)`：按 `[~/.qicode/skills, workDir/.qicode/skills]` 顺序调 `scanDirectory`
5. `scanDirectory(dir)`：try/catch 读 `readdirSync`；对每个子项 `statSync`：
   - 是目录 → 寻找 `/SKILL.md`，存在则 `loadSkill(file, fullPath, true)`
   - 不是目录、文件名 `.md` 结尾且不等于 `SKILL.md` → `loadSkill(file, dir, false)`
6. `loadSkill(filePath, sourceDir, isDirectory)`：读 UTF-8、`parseSkillFile(raw)`、为 null 跳过；构造 `Skill` 对象；try/catch `statSync(filePath).mtimeMs` 取 mtime；写入 `entries`；全程 try/catch 包住，不抛
7. `get(name)`：取 entry；若 `filePath && loadedMtimeMs > 0` 且 `statSync.mtimeMs > loadedMtimeMs`，则 `readFileSync` + `parseSkillFile` 重新填充 `entry.skill` 与 `loadedMtimeMs`；解析或读盘失败时保留缓存
8. `list()` / `has()` 简单实现
9. 私有 `parseSkillFile(content)`：校验起始 `---`、找下一个 `---`、`yaml.load(frontmatter)`、`raw?.name` 必填；映射下划线键到驼峰字段：`raw.allowed_tools → allowedTools`、`raw.fork_context → forkContext`；解析失败返回 null

**验证：** `pnpm typecheck` 通过；写一个临时脚本 `pnpm exec tsx -e 'import {SkillCatalog} from "./src/skills/catalog.ts"; const c = new SkillCatalog(); c.load("."); console.log(c.list())'` 不报错。

## T3: executor 渲染与 fail-fast

**文件：** `src/skills/executor.ts`

**依赖：** T1

**步骤：**

1. 私有 `assertAllowedToolsExist(skill, host)`：若 `allowedTools` 为 `undefined` 或长度 0 直接返回；否则遍历，每项 `host.toolRegistry().get(toolName)` 不存在时抛 `Error('skill "" declares allowed tool "" which is not registered')`
2. `export function runInline(skill, args, host): string`：
   - 先 `assertAllowedToolsExist`
   - `body = skill.body`
   - 若 `body.includes("$ARGUMENTS")` → `body = body.replaceAll("$ARGUMENTS", args)`
   - 否则若 `args` 非空 → `body += "\n\nUser Request: " + args`
   - `host.activateSkill(skill.meta.name, body)`
   - 若 `skill.meta.allowedTools` 存在（即便长度 0 也算"非 undefined"，按现实现 `if (skill.meta.allowedTools)` 走真分支）→ 构造 `Set` + `host.setToolFilter(name => allowed.has(name))`
   - 返回 body
3. `export async function runFork(skill, args, host): Promise`：
   - 先 `assertAllowedToolsExist`
   - `prompt = skill.body; if (args) prompt += "\n\nARGUMENTS: " + args`
   - `contextMode = skill.meta.forkContext ?? "none"`
   - `"recent"` → `host.snapshotParentMessages(5)`，`prompt = 'Context from parent conversation:\n\n\n' + prompt`
   - `"full"` → 同样语法，count=100
   - 调 `host.runSubAgent(prompt, skill.meta.allowedTools)` 并返回

**验证：** `pnpm typecheck` 通过；T11 单测会进一步覆盖。

## T4: LoadSkillTool

**文件：** `src/skills/load-skill-tool.ts`

**依赖：** T1, T2, T3

**步骤：**

1. import `Tool` / `ToolResult` / `strArg` from `../tools/types.js`
2. 定义 `LoadSkillTool implements Tool`：
   - `name = "LoadSkill"`
   - `description` 字符串
   - `category = "read" as const`
   - `system = true`
   - 构造函数 `(private catalog, private host)`
3. `schema()` 返回 `{ name, description, input_schema: { type: "object", properties: { name: { type: "string", description: "..." } }, required: ["name"] } }`
4. `async execute(args)`：
   - `name = strArg(args, "name")`
   - `skill = catalog.get(name)`，不存在时构造 available 列表（`catalog.list().map(s => s.name).join(", ") || "(none)"`），返回 `{ output: \`Skill '${name}' not found. Available skills: ${available}\`, isError: true }`
   - 存在时 `body = runInline(skill, "", host)`
   - 返回 `{ output: \`Skill '${name}' activated.\n\n${body}\`, isError: false }`

**验证：** `pnpm typecheck` 通过。

## T5: InstallSkillTool

**文件：** `src/skills/install-tool.ts`

**依赖：** T2

**步骤：**

1. 引入安全路径解析、临时目录、原子重命名所需的 Node API，以及统一权限服务、受限下载器、`Tool` / `ToolResult` / `strArg`；禁止直接写最终安装目录。
2. 私有函数 `nameFromFrontmatter(content)`：若不以 `---` 起头返回空串；找下一个 `---`；正则 `(?:^|\n)\s*name:\s*(.+)` 抽 name；trim
3. `InstallSkillTool implements Tool`：
   - `name = "InstallSkill"`
   - `category = "read" as const`、`system = true`
   - 构造函数 `(private workDir, private catalog, private onInstalled?)`
4. `schema()`：properties 含 `source`(required) 与 `name`(optional)
5. `async execute(args)`：
   - 只接受工作区内本地路径或 HTTPS；远程安装经过权限确认；下载具有超时、大小与重定向限制；名称为安全 slug；校验后通过临时目录 + atomic rename 安装。
   - 取 `source = strArg(args, "source")`，为空返回 isError `Error: source is required`
   - 远程来源必须为 HTTPS：先走权限确认，再调用统一受限下载器；下载器负责连接/总超时、响应体上限、重定向次数、重定向后协议复核与错误归一化。不得在工具内直接调用裸 `fetch`。
   - 本地来源解析真实路径并限制在工作区，拒绝符号链接逃逸。
   - 名称从参数/frontmatter/文件名取得后必须通过安全 slug 校验。
   - 名称为空、格式非法、内容超限或 Skill 校验失败均返回错误。
   - 写临时目录并完整校验，成功后原子 rename 到 `.qicode/skills/<name>`。
   - `catalog.load(workDir)`；`onInstalled?.()`
   - 返回 `{ output: \`Skill '${name}' installed to .qicode/skills/${name}/SKILL.md\`, isError: false }`

**验证：** `pnpm typecheck` 通过。

## T6: Tool 接口新增 system 标记

**文件：** `src/tools/types.ts`

**依赖：** 无

**步骤：**

1. 在 `Tool` 接口新增 `system?: boolean`
2. 既有工具实现可以不显式设置（默认 falsy）

**验证：** `pnpm typecheck` 通过。

## T7: prompt builder 加 skillSection 槽

**文件：** `src/prompt/builder.ts`

**依赖：** 无

**步骤：**

1. `BuildOptions` 接口新增 `skillSection?: string;`
2. `buildSystemPrompt` 内：

```ts
if (opts.skillSection) {
  b.add({ name: "Skills", priority: 90, content: opts.skillSection });
}
```

3. 顺序保证：环境 80 → Skills 90 → CustomInstructions 95 → Memory 100

**验证：** `pnpm typecheck` 通过；既有 prompt 单测仍跑过。

## T8: Agent 接入 activeSkills 与 toolFilter

**文件：** `src/agent/agent.ts`

**依赖：** T1, T6

**步骤：**

1. `AgentConfig` 接口新增：
   - `activeSkills?: Map`
   - `toolFilter?: (name: string) => boolean`
2. `Agent` 类新增成员：
   - `activeSkills: Map`
   - `private toolFilter?: (name: string) => boolean`
3. 构造函数赋值：`this.activeSkills = config.activeSkills ?? new Map()`；`this.toolFilter = config.toolFilter`
4. `run()` 入口处理 toolSchemas：

```ts
let toolSchemas = this.registry.getAllSchemas();
if (this.toolFilter) {
  toolSchemas = toolSchemas.filter((s) => {
    const n = s.name as string;
    return this.registry.get(n)?.system === true || this.toolFilter!(n);
  });
}
```

5. 在每轮迭代体内（已有 `manageContext` 调用之后），添加：

```ts
const skillReminder = buildActiveSkillsReminder(this.activeSkills);
if (skillReminder) {
  this.conversation.addSystemReminder(skillReminder);
}
```

6. 文件底部追加私有函数 `buildActiveSkillsReminder(active: Map): string`：空 Map 返回 `""`；否则拼出 `# Active Skills\n\n...\n\n## Active Skill: \n\n\n\n`

**验证：** `pnpm typecheck` 通过；`pnpm test -- tests/agent.test.ts` 通过（既有测试无 toolFilter / activeSkills 时行为不变）。

## T9: 命令类型新增 skill_fork + /skills 命令

**文件：** `src/commands/commands.ts`

**依赖：** 无

**步骤：**

1. `CommandType` 联合追加 `"skill_fork"`
2. `createDefaultRegistry()` 内 register 一条：

```ts
registry.register({
  name: "skills",
  aliases: [],
  type: "local_ui",
  description: "List available skills",
  handler: () => "skills",
});
```

3. 第 09 章 `/review` 内置 prompt 命令保留不动；Skill 用户若定义同名 `/review`，会被 `wireSkillsToRegistry` 的 `cmdRegistry.find` 短路掉

**验证：** `pnpm typecheck` 通过；`pnpm test -- tests/command-loader.test.ts` 通过。

## T10: TUI 接入 — refs / host / wireSkillsToRegistry / dispatch

**文件：** `src/tui/app.tsx`

**依赖：** T1-T9

**步骤：**

1. 文件顶部 import：
   - `import { SkillCatalog } from "../skills/catalog.js"`
   - `import { runInline as runSkillInline, runFork as runSkillFork } from "../skills/executor.js"`
   - `import { LoadSkillTool } from "../skills/load-skill-tool.js"`
   - `import { InstallSkillTool } from "../skills/install-tool.js"`
   - `import type { SkillHost, SkillForkHost } from "../skills/skill.js"`
   - 既有 `Command` / `CommandRegistry` 类型若没暴露则补 import
2. 新增 module-level 函数 `wireSkillsToRegistry(catalog, cmdRegistry, skillHost)`：

```ts
function wireSkillsToRegistry(
  catalog: SkillCatalog,
  cmdRegistry: CommandRegistry,
  skillHost: SkillHost,
): void {
  for (const meta of catalog.list()) {
    if (cmdRegistry.find(meta.name)) continue;
    const skill = catalog.get(meta.name);
    if (!skill) continue;
    const isFork = skill.meta.mode === "fork";
    const cmd: Command = {
      name: meta.name,
      aliases: [],
      type: isFork ? "skill_fork" : "prompt",
      description: `${meta.description} [skill]`,
      handler: isFork
        ? () => ""
        : (ctx) => runSkillInline(skill, ctx.args, skillHost),
    };
    try { cmdRegistry.register(cmd); } catch { /* name clash */ }
  }
}
```

3. `App` 函数体内新增 refs：
   - `skillCatalogRef = useRef(null)`
   - `activeSkillsRef = useRef(new Map())`
   - `toolFilterRef = useRef boolean) | null>(null)`
   - `skillHostRef = useRef({ activateSkill: (n, b) => activeSkillsRef.current.set(n, b), setToolFilter: (f) => { toolFilterRef.current = f }, toolRegistry: () => registryRef.current })`
4. `initClient` 内（在 user commands 加载之前/之后均可，按 ts 当前实现是 catalog 先于 user 命令）：
   - `const catalog = new SkillCatalog(); catalog.load(workDir); skillCatalogRef.current = catalog`
   - `registryRef.current.register(new LoadSkillTool(catalog, skillHostRef.current))`
   - `registryRef.current.register(new InstallSkillTool(workDir, catalog, () => wireSkillsToRegistry(catalog, cmdRegistryRef.current, skillHostRef.current)))`
   - 加载 user commands 完毕后调 `wireSkillsToRegistry(catalog, cmdRegistryRef.current, skillHostRef.current)`
5. `executeCommand` 顶部 `/skill  [args]` 短句重写：

```ts
if (parsed.name === "skill" && parsed.args.trim()) {
  const parts = parsed.args.trim().split(/\s+/);
  parsed = { name: parts[0], args: parts.slice(1).join(" ") };
}
```

6. `executeCommand` 的 `local_ui` 分支新增 `case "skills":` action 处理：从 `skillCatalogRef.current?.list()` 渲染清单
7. `executeCommand` 末尾新增 `if (cmd.type === "skill_fork") { ... }` 分支：

```ts
if (cmd.type === "skill_fork") {
  const skill = skillCatalogRef.current?.get(parsed.name);
  if (!skill) { setMessages(prev => [...prev, { role: "system", content: `Skill not found: ${parsed.name}` }]); return true; }
  const client = providerRef.current;
  if (!client) { setMessages(prev => [...prev, { role: "system", content: "Client not ready." }]); return true; }
  setMessages(prev => [...prev, { role: "system", content: `Running skill "${parsed.name}" in fork mode…` }]);
  const forkHost: SkillForkHost = {
    ...skillHostRef.current,
    runSubAgent: (prompt, tools) => spawnSubAgent(
      { name: skill.meta.name, description: skill.meta.description, tools, model: skill.meta.model },
      prompt, client, registryRef.current, selectedProvider, workDir
    ),
    snapshotParentMessages: (count) => convRef.current.getMessages()
      .slice(-count)
      .map(m => `[${m.role}] ${m.content}`)
      .join("\n"),
  };
  runSkillFork(skill, parsed.args, forkHost)
    .then(result => setMessages(prev => [...prev, { role: "assistant", content: result }]))
    .catch(err => setMessages(prev => [...prev, { role: "system", content: `Skill fork error: ${(err as Error).message}` }]));
  return true;
}
```

8. `runAgentLoop` 内构造 `new Agent({...})` 时新增字段：

```ts
activeSkills: activeSkillsRef.current,
toolFilter: buildComposedToolFilter(coordinatorToolFilter(teamManagerRef.current), toolFilterRef.current),
```

**验证：** `pnpm typecheck` 通过；`pnpm dev` 能启动到 TUI。

## T11: runInline 单测

**文件：** `tests/skills.test.ts`

**依赖：** T2-T4

**步骤：**

1. 引入 `describe / it / expect` from `"Vitest"`；`runInline` from `"../src/skills/executor.js"`；`ToolRegistry` from `"../src/tools/registry.js"`；类型 `Skill / SkillHost` from skill.ts
2. 工厂 `makeHost()`：创建 `activated: [string, string][]`、`filter`；构造 `ToolRegistry` 并 register 两个 stub：`ReadFile` / `Grep`（`schema()` 返回 `{ name, description, input_schema: {} }`；`execute` 返回 `{ output: "", isError: false }`）；返回 `{ host, activated, getFilter: () => filter }`
3. 工厂 `skill(body, allowedTools?)` 构造 `Skill` 对象
4. 用例 1 "substitutes $ARGUMENTS and pins the SOP + tool filter"：
   - `body = runInline(skill("Do $ARGUMENTS now.", ["ReadFile", "Grep"]), "the thing", host)`
   - `expect(body).toBe("Do the thing now.")`
   - `expect(activated[0][0]).toBe("demo"); expect(activated[0][1]).toBe("Do the thing now.")`
   - `filter("ReadFile") === true`，`filter("Bash") === false`
5. 用例 2 "appends a User Request fallback when there is no placeholder"：
   - `runInline(skill("SOP body"), "extra context", host)`
   - body 含 `"SOP body"` 与 `"User Request: extra context"`
6. 用例 3 "does not set a tool filter when the skill allows all tools"：
   - `runInline(skill("body"), "", host)`
   - `getFilter() === null`

**验证：** `pnpm test -- tests/skills.test.ts` 三个 case 全过。

## T12: InstallSkillTool 单测

**文件：** `tests/install-skill.test.ts`

**依赖：** T5

**步骤：**

1. 引入 Vitest API 与 `mkdtempSync / writeFileSync / existsSync / readFileSync / tmpdir / join`
2. 准备 fixture SKILL.md 字符串：

```
const SKILL = `---
name: commit-helper
description: Helps write commits
allowed_tools: [Bash, ReadFile]
---
Write a conventional-commit message for the staged changes.`;
```

3. 用例 1 "installs a skill from a local path and loads it into the catalog"：
   - `workDir = mkdtempSync(...)`；写 `srcPath = workDir/src-skill.md`
   - `catalog = new SkillCatalog()`
   - `r = await new InstallSkillTool(workDir, catalog).execute({ source: srcPath })`
   - 断言 `r.isError === false`、`r.output` 含 `"commit-helper"`、`/.qicode/skills/commit-helper/SKILL.md` 存在、内容含 `"conventional-commit"`、`catalog.has("commit-helper")` 为 true
4. 用例 2 "errors on a missing local source"：调 `execute({ source: "nope.md" })`，`r.isError === true`
5. 用例 3 "honors an explicit name override"：传 `{ source: srcPath, name: "renamed" }`，最终落到 `.qicode/skills/renamed/SKILL.md`

**验证：** `pnpm test -- tests/install-skill.test.ts` 三个 case 全过。

## T13: 启动期联调

**文件：** 无（运行验证）

**依赖：** T1-T12

**步骤：**

1. `pnpm dev` 启动 TUI
2. 在 `.qicode/skills/foo/SKILL.md` 放一个最简 Skill（仅 frontmatter `name`, `description`），重启
3. 键入 `/skills` 回车，预期输出 `Available skills:` 后跟一行 `  /foo — `
4. 键入 `/help`，预期含 `/foo` 行且描述末尾带 `[skill]`
5. 键入 `/foo` 回车，inline 路径走通，conversation 多一条 user 消息

**验证：** TUI 行为符合预期，进程不 panic。

## T14: 端到端验证

按 checklist.md 中端到端场景章节，在终端里把所有路径跑一遍（含 fork 模式、`LoadSkill` 工具调用、`InstallSkill` 安装、热重载）。

## 执行顺序

```text
T1 → T2 → T3
  ├─ T4 (LoadSkillTool, 依赖 T1-T3)
  └─ T5 (InstallSkillTool, 依赖 T2)

T6 (Tool 接口扩 system) — 独立可早做

T7 (prompt builder) — 独立

T8 (Agent activeSkills + toolFilter, 依赖 T1, T6)

T9 (CommandType + /skills 内置, 独立)

T10 (TUI 接入, 依赖 T1-T9)

T11 (runInline 单测, 依赖 T2-T4)
T12 (InstallSkillTool 单测, 依赖 T5)

T13 (启动联调, 依赖 T1-T12)
T14 (端到端验证, 依赖 T13)
```

可并行：T6 / T7 / T9 之间彼此独立；T11 / T12 单测彼此独立；其余按线性依赖推进。
## 学习文档任务

代码、测试和手工验证完成后，新增本章学习文档。内容必须从真实实现提取：

- 一条主调用链及准确文件/行号。
- 高频面试问题的一句话、项目回答、深挖追问和诚实边界。
- 推荐断点、观察变量、正常值、异常含义和下一步追踪位置。
- 至少三个可重复的故障注入实验。
- 一个由学习者独立完成的小改动，完成后进行代码 Review。

**验证：** 学习者能够不看答案复述本章数据流，并按文档完成至少一次断点调试。

## 开发开始条件

- [ ] 用户明确说“开发第 10 章”。
- [ ] 前置章节已完成或本章明确使用可测试替身。
- [ ] spec、plan、task、check 的术语、接口和验收标准没有冲突。
