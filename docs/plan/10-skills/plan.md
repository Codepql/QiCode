# QiCode 第10阶段技术计划：Skill 系统

> 状态：规划中，等待用户明确说“开发第 10 章”后执行。
>
> 前置章节：01-09。本章沿用第 01 章的 Node.js 22 LTS、pnpm 10.14.0、TypeScript、Vitest、统一 `Provider` 和两种 protocol 基线。
>
> 本文只描述架构与技术取舍；需求依据见 `spec.md`，执行任务见 `task.md`。

## 技术栈

- 运行时：Node.js 22 LTS（package.json `"type": "module"`，bin 直接执行 `src/main.tsx`）
- 语言：TypeScript 5.x，严格模式，`pnpm typecheck` 静态检查
- TUI：Ink 5 + React 18，`ink-spinner` / `ink-text-input` 提供输入与等待态
- LLM 协议层：沿用第 01 章基于 Node 原生 `fetch`、Web Streams 与统一 `Provider` 的实现。
- MCP：`@modelcontextprotocol/sdk`，由 `src/mcp/manager.ts` 注入工具
- 解析：`js-yaml` 处理 SKILL.md frontmatter，`marked` + `marked-terminal` 渲染消息
- 测试：Vitest（`pnpm test`），所有 skill 单测落在 `tests/*.test.ts`

## 架构概览

新增一个 `src/skills/` 目录承载所有 Skill 相关的"数据 + 加载 + 执行 + 激活态"逻辑，与现有 `src/commands/`、`src/tools/`、`src/prompt/`、`src/agent/`、`src/tui/` 通过细窄接口交互。

按职责拆解：

- **src/skills/skill.ts**：类型定义。`SkillMeta` / `Skill` / `SkillHost` / `SkillForkHost` 接口
- **src/skills/catalog.ts**：`SkillCatalog` 类。`load()` 扫描用户/项目两层目录、`get()` 带 mtime 热重载、`list()` / `has()` 暴露给上层
- **src/skills/executor.ts**：纯函数 `runInline` 与 `runFork`，加上私有 `assertAllowedToolsExist` 做 fail-fast 依赖检查
- **src/skills/load-skill-tool.ts**：`LoadSkillTool` 类实现 `Tool` 接口，`system: true` 标记，模型按需激活
- **src/skills/install-tool.ts**：`InstallSkillTool` 类实现 `Tool` 接口，支持 skills.sh / github.com tree / raw URL 三种格式，走 GitHub Contents API 递归拉取目录树，atomic rename 安装到 ~/.qicode/skills/
- **src/prompt/builder.ts**：扩展 `BuildOptions.skillSection` 字段（priority 90 落到 `PromptBuilder`）
- **src/agent/agent.ts**：构造参数新增 `activeSkills?: Map` 与 `toolFilter?: (name: string) => boolean`；`run()` 每轮调用 `buildActiveSkillsReminder` 注入 SOP；工具 schema 投递前应用 `toolFilter` 过滤
- **src/commands/commands.ts**：`CommandType` 新增 `"skill_fork"` 联合类型成员；内置一条 `name: "skills"` 的 `local_ui` 命令（handler 返回 action 字符串 `"skills"`）
- **src/tui/app.tsx**：构造 `SkillCatalog`、`activeSkillsRef`、`toolFilterRef`、`skillHostRef`；定义 `wireSkillsToRegistry` 把 catalog 项注册为 `prompt` / `skill_fork` 命令；`executeCommand` 内识别 `skill_fork` 类型走 `runFork + spawnSubAgent` 路径

## 数据流

### 启动期

```
initClient (in App component):
  ├─ new SkillCatalog()
  ├─ catalog.load(workDir)        // 扫描 ~/.qicode/skills + workDir/.qicode/skills
  ├─ registry.register(new LoadSkillTool(catalog, skillHostRef.current))
  ├─ registry.register(new InstallSkillTool(workDir, catalog, onInstalled))
  ├─ loadUserCommands(workDir) → cmdRegistry.register(...)
  └─ wireSkillsToRegistry(catalog, cmdRegistry, skillHostRef.current)
        其中 onInstalled = () => wireSkillsToRegistry(catalog, cmdRegistry, skillHostRef.current)
```

### Skill 显式调用：`/foo`（inline）

```
input → parse → cmdRegistry.find("foo")
  cmd.type === "prompt"
  → promptText = cmd.handler({workDir, args}) === runInline(skill, args, skillHost)
        ├ assertAllowedToolsExist(skill, host)
        ├ render body ($ARGUMENTS / User Request fallback)
        ├ host.activateSkill(name, body)   // activeSkillsRef.current.set
        └ host.setToolFilter(name => allowed.has(name))   // toolFilterRef.current
  → conv.addUserMessage(promptText) + setMessages
  → runAgentLoop()
        Agent.run() 每轮 buildActiveSkillsReminder 把 SOP 重新钉回 system reminder
```

### Skill 显式调用：`/review`（fork）

```
input → parse → cmdRegistry.find("review")
  cmd.type === "skill_fork"
  → executeCommand 命中 skill_fork 分支
  → forkHost = { ...skillHostRef.current, runSubAgent, snapshotParentMessages }
  → runSkillFork(skill, args, forkHost)
        ├ assertAllowedToolsExist(skill, host)
        ├ build prompt: body + "\n\nARGUMENTS: "（若有）
        ├ forkContext = "recent" / "full" → 取 5 / 100 条父消息拼到 prompt 前
        └ host.runSubAgent(prompt, allowedTools)
              → spawnSubAgent({ name, description, tools, model }, prompt, client, registry, provider, workDir)
        → resolve(result)
  → setMessages([..., { role: "assistant", content: result }])
```

### Skill 意图触发（自然语言 → LoadSkill）

```
user 输入 "帮我写个 commit message"
  → runAgentLoop → agent.run() → LLM stream → tool_use: LoadSkill({name:"commit"})
  → LoadSkillTool.execute
        ├ catalog.get("commit") (hot-reload by mtime)
        ├ runInline(skill, "", skillHost)
        │     activateSkillsRef.current.set("commit", body)
        │     toolFilterRef.current = name => allowed.has(name)
        └ return { output: "Skill 'commit' activated.\n\n" }
  → 下一轮迭代：
        buildActiveSkillsReminder(activeSkills) 渲染出 "# Active Skills..."
        conv.addSystemReminder(...) 注入到下次 LLM 调用前
        agent.run() 内部 toolSchemas = registry.getAllSchemas().filter(toolFilter || system)
```

### `/clear`

```
/clear handler (local_ui, action="clear")
  → setMessages([])
  → committedIndexRef.current = 0
  → convRef.current = new ConversationManager()
  (注：activeSkillsRef 与 toolFilterRef 当前实现下未在 /clear 时显式重置)
```

### `InstallSkill` 安装

```
InstallSkillTool.execute({ source, name? }):
  ├ source ~ /^https:/   → 受限 fetch（超时/大小/redirect）→ resp.text()
  │   else                → readFileSync(absolute or join(workDir, source))
  ├ name = validatedSlug(arg.name || frontmatter.name || basename)
  ├ 写临时目录并校验完整 Skill
  ├ atomic rename 到 workDir/.qicode/skills/<name>/
  ├ catalog.load(workDir)               // 重新扫描
  └ onInstalled?.()                     // app.tsx 重新 wireSkillsToRegistry
```

## 核心数据结构与接口

### `SkillMeta` / `Skill`

```ts
// src/skills/skill.ts
export interface SkillMeta {
  name: string;
  description: string;
  allowedTools?: string[];
  mode?: "inline" | "fork";
  model?: string;
  forkContext?: "full" | "recent" | "none";
}

export interface Skill {
  meta: SkillMeta;
  body: string;          // SKILL.md 去掉 frontmatter 后的正文
  sourceDir: string;     // 目录型时是目录路径；单文件时是上层目录
  isDirectory: boolean;  // 用于后续区分目录型与单文件 Skill
}
```

约定：

- 解析时 `mode` 缺省映射为 `"inline"`：`(raw.mode as "inline" | "fork") ?? "inline"`
- `forkContext` 缺省为 `undefined`，`runFork` 内 `?? "none"`

### `SkillHost` / `SkillForkHost`

```ts
export interface SkillHost {
  activateSkill(name: string, body: string): void;
  setToolFilter(filter: ((name: string) => boolean) | null): void;
  toolRegistry(): ToolRegistry;
}

export interface SkillForkHost extends SkillHost {
  runSubAgent(prompt: string, toolFilter?: string[]): Promise;
  snapshotParentMessages(count: number): string;
}
```

TUI 端通过 `useRef` 持有稳定的 host 对象，闭包捕获 `activeSkillsRef` / `toolFilterRef` / `registryRef`。

### `SkillCatalog`

```ts
// src/skills/catalog.ts
interface CatalogEntry {
  skill: Skill;
  filePath: string;       // SKILL.md 绝对路径，热重载用
  loadedMtimeMs: number;  // 上次加载时的 mtime
}

export class SkillCatalog {
  private entries = new Map();

  load(workDir: string): void;            // 顺序扫描 ~/.qicode/skills 与 workDir/.qicode/skills
  private scanDirectory(dir: string): void;
  private loadSkill(filePath: string, sourceDir: string, isDirectory: boolean): void;

  list(): SkillMeta[];
  get(name: string): Skill | undefined;   // mtime 热重载入口
  has(name: string): boolean;
}
```

### `Tool` 接口与系统标记

```ts
// src/tools/types.ts
export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;   // "read" | "write" | "command"
  deferred?: boolean;
  system?: boolean;         // ← LoadSkill / InstallSkill 在工具过滤时永久豁免

  schema(): Record;
  execute(args: Record, ctx: ToolContext): Promise;
}
```

### `LoadSkillTool` / `InstallSkillTool`

```ts
// src/skills/load-skill-tool.ts
export class LoadSkillTool implements Tool {
  name = "LoadSkill";
  category = "read" as const;
  system = true;

  constructor(private catalog: SkillCatalog, private host: SkillHost) {}

  schema(): Record;
  execute(args: Record): Promise;
}

// src/skills/install-tool.ts
export class InstallSkillTool implements Tool {
  name = "InstallSkill";
  category = "read" as const;
  system = true;

  constructor(
    private workDir: string,
    private catalog: SkillCatalog,
    private onInstalled?: () => void
  ) {}
}
```

### 执行器函数

```ts
// src/skills/executor.ts
function assertAllowedToolsExist(skill: Skill, host: SkillHost): void;

export function runInline(
  skill: Skill,
  args: string,
  host: SkillHost
): string;          // 同步返回渲染后的 body

export async function runFork(
  skill: Skill,
  args: string,
  host: SkillForkHost
): Promise; // 子 Agent 的最终输出
```

### `Command` 与 `CommandType`

```ts
// src/commands/commands.ts
export type CommandType = "local" | "local_ui" | "prompt" | "skill_fork";

export interface Command {
  name: string;
  aliases: string[];
  type: CommandType;
  description: string;
  handler: (ctx: CommandContext) => string;
}
```

### `Agent` 配置新增字段

```ts
// src/agent/agent.ts
export interface AgentConfig {
  // ...既有字段...
  activeSkills?: Map;
  toolFilter?: (name: string) => boolean;
}

export class Agent {
  // ...
  activeSkills: Map;
  private toolFilter?: (name: string) => boolean;
}
```

## 模块设计

### `src/skills/skill.ts`

**职责**：类型与接口契约

**对外接口**：`SkillMeta` / `Skill` / `SkillHost` / `SkillForkHost`

**依赖**：仅 `../tools/registry.js`（类型用）

### `src/skills/catalog.ts`

**职责**：扫描磁盘 → `Map`；按 mtime 热重载

**对外接口**：`SkillCatalog` 类

**依赖**：`node:fs`（`readdirSync` / `readFileSync` / `existsSync` / `statSync`）、`node:path` 的 `join`、`node:os` 的 `homedir`、`js-yaml`

**关键函数**：`parseSkillFile(content)` 私有，返回 `{ meta, body } | null`；frontmatter 解析失败、缺 `name` 字段时返回 null

### `src/skills/executor.ts`

**职责**：把 Skill 渲染并钉到上下文（inline）或转交子 Agent（fork）

**对外接口**：`runInline` / `runFork`

**依赖**：`./skill.js` 接口；不依赖任何具体 UI 或 Agent 实现

`runInline` 是纯同步函数：先 fail-fast 检查 `allowedTools`，再渲染 body，再回调 host 两次（`activateSkill` + 条件 `setToolFilter`）；返回的 body 字符串供命令 handler 作为 prompt 使用。

`runFork` 是 async 函数：渲染 prompt，按 `forkContext` 取父对话片段，最后 await `host.runSubAgent`。

### `src/skills/load-skill-tool.ts`

**职责**：把 catalog 中的 Skill 按需激活的工具实现

**对外接口**：`LoadSkillTool` 类

**依赖**：`../tools/types.js` 的 `Tool` / `ToolResult` / `strArg`、`./catalog.js`、`./skill.js`、`./executor.js`

`execute()` 流程：

1. `strArg(args, "name")` 解析
2. `catalog.get(name)` —— 触发热重载
3. 不存在：列出 `catalog.list().map(s => s.name).join(", ")` 返回 isError
4. 存在：`runInline(skill, "", this.host)`
5. 返回 `Skill '' activated.\n\n`

### `src/skills/install-tool.ts`

**职责**：从工作区内本地路径或 HTTPS URL 获取 Skill，经权限、大小、名称和格式校验后原子安装到 `.qicode/skills/<name>/SKILL.md`。

**对外接口**：`InstallSkillTool` 类

**依赖**：`node:fs` 的 `mkdirSync` / `writeFileSync` / `readFileSync` / `existsSync`、`node:path` 的 `join` / `isAbsolute` / `basename`、`../tools/types.js`、`./catalog.js`

`execute()` 流程：

1. 取 `source` 必填
2. https URL → fetch；本地路径 → `isAbsolute` 后 `join(workDir, source)`，存在性检查后 `readFileSync`
3. 解析 `name`：优先用户传参；次选 frontmatter；兜底 `basename(source).replace(/\.md$/, "")`
4. `mkdirSync(targetDir, { recursive: true })` + `writeFileSync(SKILL.md, content)`
5. `catalog.load(workDir)` 重扫
6. `this.onInstalled?.()` 通知上层重新 wire 命令

### `src/agent/agent.ts`

**修改**：

- `AgentConfig` 接口新增 `activeSkills?: Map` 与 `toolFilter?: (name: string) => boolean`
- 类成员 `activeSkills: Map` / `private toolFilter`
- `run()` 入口先取 `let toolSchemas = this.registry.getAllSchemas()`；若有 `toolFilter`，按 `s => registry.get(s.name)?.system === true || this.toolFilter!(s.name)` 过滤
- 每轮迭代调 `buildActiveSkillsReminder(this.activeSkills)`，非空时 `this.conversation.addSystemReminder(reminder)`

`buildActiveSkillsReminder` 内部实现：

```ts
function buildActiveSkillsReminder(active: Map): string {
  if (active.size === 0) return "";
  let out = "# Active Skills\n\nThe following Skill SOPs are pinned to the environment context. Follow each SOP when its triggering condition applies.\n\n";
  for (const [name, body] of active) {
    out += `## Active Skill: ${name}\n\n${body}\n\n`;
  }
  return out;
}
```

### `src/prompt/builder.ts`

**修改**：`BuildOptions` 新增可选字段 `skillSection?: string`；`buildSystemPrompt` 中：

```ts
if (opts.skillSection) {
  b.add({ name: "Skills", priority: 90, content: opts.skillSection });
}
```

priority 90 位于 `CustomInstructions`(95) 与 `Memory`(100) 之前、`Environment`(80) 之后。

### `src/commands/commands.ts`

**修改**：

- `CommandType` 联合追加 `"skill_fork"` 成员
- `createDefaultRegistry` 中新增 `name: "skills"` 内置命令：

```ts
registry.register({
  name: "skills",
  aliases: [],
  type: "local_ui",
  description: "List available skills",
  handler: () => "skills",
});
```

handler 返回 action 字符串 `"skills"`，由 `app.tsx` 的 `local_ui` 分支按 action 处理实际渲染。

### `src/tui/app.tsx`

**修改**：

- 顶部 import `SkillCatalog` / `runInline as runSkillInline` / `runFork as runSkillFork` / `LoadSkillTool` / `InstallSkillTool` / `SkillHost` / `SkillForkHost`
- 新增 module-level 函数 `wireSkillsToRegistry(catalog, cmdRegistry, skillHost)`：遍历 `catalog.list()`，对每个 `meta` 拿到 `skill = catalog.get(meta.name)`，按 `mode === "fork"` 注册 `skill_fork` 类型，否则注册 `prompt` 类型；handler 闭包捕获 `skill` 与 `skillHost`
- 在 `App` 内新增 refs：
  - `skillCatalogRef = useRef(null)`
  - `activeSkillsRef = useRef(new Map())`
  - `toolFilterRef = useRef boolean) | null>(null)`
  - `skillHostRef = useRef({ activateSkill, setToolFilter, toolRegistry })`
- `initClient` 中：构造 `catalog`、调 `catalog.load(workDir)`、把 catalog 存到 `skillCatalogRef`、注册两个工具、`wireSkillsToRegistry(...)` 兜底
- `executeCommand` 中追加 `if (cmd.type === "skill_fork") { ... }` 分支：构造 `SkillForkHost`（带 `runSubAgent: spawnSubAgent(...)` 与 `snapshotParentMessages: getMessages().slice(-count).map([role] content).join("\n")`），调 `runSkillFork(skill, parsed.args, forkHost)`，then 后 push assistant 消息，catch 后 push system 错误
- `local_ui` 分支识别 `"skills"` action，按 `catalog.list()` 渲染列表
- `runAgentLoop` 内构造 `Agent` 时传 `activeSkills: activeSkillsRef.current` 与 `toolFilter: buildComposedToolFilter(coordinatorToolFilter(teamManagerRef.current), toolFilterRef.current)`
- `/skill  [args]` 短句重写：在 `executeCommand` 顶部 `if (parsed.name === "skill" && parsed.args.trim())` 时把 `parsed` 改写为 `{ name: parts[0], args: parts.slice(1).join(" ") }`

## 模块交互

### 启动期时序

```
App.useEffect → initClient(provider)
  ├ createProvider(provider, systemPrompt)
  ├ new SkillCatalog() → catalog.load(workDir)
  ├ registry.register(new LoadSkillTool(catalog, skillHost))
  ├ registry.register(new InstallSkillTool(workDir, catalog, onInstalled))
  ├ loadUserCommands(workDir).forEach(cmdRegistry.register)
  └ wireSkillsToRegistry(catalog, cmdRegistry, skillHost)
        for meta in catalog.list():
          if (!cmdRegistry.find(meta.name))
            cmdRegistry.register({ name, type: isFork ? "skill_fork" : "prompt", ... })
```

### 显式调用 inline Skill 的调用链

```
input.tsx onSubmit
  → App.onUserInput
     → executeCommand(parsed)
        → cmd.type === "prompt"
        → promptText = cmd.handler({workDir, args})
              = runSkillInline(skill, args, skillHost)
                    → assertAllowedToolsExist
                    → render body
                    → skillHost.activateSkill (Map.set)
                    → skillHost.setToolFilter (when allowedTools)
                    → return body
        → conv.addUserMessage(promptText)
        → setMessages
        → runAgentLoop()
              → new Agent({ activeSkills: activeSkillsRef.current,
                             toolFilter: composedFilter, ... })
              → agent.run() 每轮：
                  ├ toolSchemas = filter by toolFilter
                  ├ buildActiveSkillsReminder → addSystemReminder
                  └ streamLLM
```

### 显式调用 fork Skill 的调用链

```
executeCommand → cmd.type === "skill_fork" 分支
  ├ skill = skillCatalogRef.current?.get(parsed.name)
  ├ forkHost = {
  │     activateSkill, setToolFilter, toolRegistry,
  │     runSubAgent: (prompt, tools) => spawnSubAgent(
  │         { name, description, tools, model },
  │         prompt, client, registry, provider, workDir),
  │     snapshotParentMessages: count =>
  │         convRef.getMessages().slice(-count).map(...).join("\n"),
  │ }
  └ runSkillFork(skill, parsed.args, forkHost)
        ├ assertAllowedToolsExist
        ├ render prompt + fork_context snapshot
        └ host.runSubAgent(prompt, allowedTools)
              → spawnSubAgent → new Agent (sub) → agent.run()
              → 收集子 Agent stream_text 拼成 output → resolve(output)
        .then(result => setMessages([..., { role: "assistant", content: result }]))
        .catch(err => setMessages([..., { role: "system", content: "Skill fork error: ..." }]))
```

### LoadSkill 工具调用时序

```
agent.run() → LLM 返回 tool_use { name: "LoadSkill", input: { name: "commit" } }
  → permission check (LoadSkill 是 read 类，且 system=true → 自动放行)
  → tool.execute(args, ctx)
        ├ catalog.get("commit")  // 触发 mtime 热重载
        ├ runInline(skill, "", host) 同步执行
        │     → activeSkillsRef.set("commit", body)
        │     → toolFilterRef = name => allowed.has(name)
        └ return { output: "Skill 'commit' activated.\n\n", isError: false }
  → 下一轮迭代：
        toolSchemas = registry.getAllSchemas().filter(s =>
          registry.get(s.name).system === true || toolFilter(s.name))
        buildActiveSkillsReminder 渲染 # Active Skills... → addSystemReminder
        模型在 system reminder 中看到完整 SOP，且工具集已收窄
```

## 文件组织

```text
qicode/
├── src/
│   ├── skills/                          # 新增包
│   │   ├── skill.ts                     # SkillMeta / Skill / SkillHost / SkillForkHost
│   │   ├── catalog.ts                   # SkillCatalog: load / get (mtime 热重载) / list / has
│   │   ├── executor.ts                  # runInline / runFork / assertAllowedToolsExist
│   │   ├── load-skill-tool.ts           # LoadSkillTool 实现 Tool 接口
│   │   └── install-tool.ts              # InstallSkillTool 实现 Tool 接口
│   ├── agent/
│   │   └── agent.ts                     # 修改：activeSkills + toolFilter + buildActiveSkillsReminder
│   ├── prompt/
│   │   └── builder.ts                   # 修改：BuildOptions.skillSection 槽位 (priority 90)
│   ├── commands/
│   │   └── commands.ts                  # 修改：CommandType += "skill_fork" + 内置 /skills
│   └── tui/
│       └── app.tsx                      # 修改：wireSkillsToRegistry + refs + skill_fork dispatch
└── tests/
    ├── skills.test.ts                   # runInline 单测：$ARGUMENTS / fallback / toolFilter
    └── install-skill.test.ts            # InstallSkillTool 单测：本地路径 / 缺失 source / name override
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 数据格式 | 仅 SKILL.md（frontmatter+body） | 与 README 一致；解析路径单一；不引入 yaml/md 分离的认知负担 |
| Skill 形态 | 支持目录 + 单文件 `.md` | 单文件 Skill 上手成本极低；目录型为附属资料留位 |
| 优先级覆盖 | 用户级  boolean) | null>` | 跨 render 稳定；`buildComposedToolFilter` 与 team coordinator 过滤器合成 |
| `activeSkills` 存放位置 | `useRef>` | 比 state 更适合频繁写入；Agent 拿到的是同一 Map 引用 |
| TS 类型策略 | strict + `Record` 取 tool args | 与既有 Tool 接口风格一致；通过 `strArg` 辅助函数取值 |
| `pnpm test` 统一运行 Vitest | 直接用 Vitest test runner | 与 monorepo 无需额外配置；启动快 |

---

# Skill 技能包系统 Tasks

> 本章模块位于 `src/skills/`，运行时是 Node.js 22 LTS + TypeScript 5.x；测试通过 `pnpm test`，类型检查通过 `pnpm typecheck`。
