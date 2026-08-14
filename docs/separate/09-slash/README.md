# 09-Slash 开发分割

> 依据：`docs/plan/09-slash/`，并按第八章验收后的真实代码调整。开始开发前只新增本章规划与 Start 文档；不创建源码或测试。

## 真实起点与规划差异

| 原规划假设 | 当前仓库事实 | 本章处理方式 |
| --- | --- | --- |
| 输入组件是 `src/tui/input.tsx` | 真实文件为 `src/tui/input-box.tsx` | 所有补全改造以 `input-box.tsx` 为准 |
| 已依赖 `fuse.js` | `package.json` 未安装该依赖 | 先实现确定性的名称/别名前缀匹配；模糊匹配是否引入依赖在对应阶段确认 |
| 命令尚未接入 | `App.submit()` 已有多段硬编码命令分支 | 先建立 Registry，再逐步迁移，不能一次重写整个 submit |
| `.qicode` 是唯一运行目录 | 当前项目已有 `.QiCode` 约定 | 自定义命令和 usage 文件目录须在实现前统一，不混用大小写路径 |

## 分割原则

命令核心、用户文件加载、输入补全、App 分发是四种不同风险：

```text
命令定义与冲突检查
        |
        +--> 自定义命令加载
        |
        +--> 使用记录
        |
        +--> 输入补全 UI
                    |
                    v
              App 分发迁移
                    |
                    v
              端到端验收
```

先把不依赖 TUI 的纯逻辑做稳，再改输入交互，最后迁移 `App.submit()`。这样出现问题时能分清是注册、补全还是运行时副作用导致的。

## 第 1 阶段：命令模型、解析和 Registry

**目标**：新建 `src/commands/commands.ts`，让命令可以被统一声明、注册、查找和补全。

**实现内容**：

- 定义 `Command`、`CommandType`、`CommandContext`。
- 实现 `CommandRegistry.register()`、`hasConflict()`、`find()`、`listCommands()`、`complete()`。
- 实现纯函数 `parseCommand()`：只解析 `/name args`，不执行任何动作。
- 建立默认命令定义，但不改变 App 的实际执行路径。

**为什么先做它**：这是本章所有功能的共同数据源。`/help`、补全菜单、自定义命令和未来模块必须看到同一份命令表。

**完成标志**：同名和别名冲突都能明确报错；别名可以命中主命令；列表稳定排序；普通文本不会被解析为命令。

**本阶段总结应回答**：Registry 为什么只管理“命令描述”，而不直接操作 React 状态？

## 第 2 阶段：默认命令定义与使用记录

**目标**：补齐当前已有能力的默认命令元数据，并持久化命令使用频次。

**实现内容**：

- `createDefaultRegistry()` 注册截至第八章已存在的 `/plan`、`/memory`、`/resume`、`/rewind`、`/compact`、`/permission`、`/mcp` 等命令，以及本章新增的 `/help`、`/status`、`/clear`、`/session`、`/review`、`/quit`。
- 新建 `src/commands/usage-tracker.ts`，记录命令名、使用次数和最后使用时间。
- 确认运行时文件落在统一的 `.QiCode` 目录；写失败时降级，不影响聊天。

**完成标志**：`/help` 的列表来自 Registry，而不是另一份硬编码数组；使用记录只改变候选排序，不改变权限或命令含义。

**注意**：本阶段不接入 App，不要误以为“已注册”就代表用户已经可以执行新命令。

## 第 3 阶段：用户自定义命令加载器

**目标**：新建 `src/commands/loader.ts`，把用户级和项目级 Markdown 命令文件转成 `prompt` 类型的 `Command`。

**实现内容**：

- 扫描用户目录和项目目录，项目级同名条目覆盖用户级条目。
- 支持 frontmatter 中的描述、别名、参数提示。
- 子目录转成命名空间，例如 `git/sync.md` 对应 `/git:sync`。
- 实现 `$ARGUMENTS` 全量替换；没有占位符时将参数追加到正文后。
- 单个目录、文件或 frontmatter 损坏时跳过并产生诊断，不能阻断启动。

**完成标志**：加载器只返回命令定义，不直接调用 Agent；与内置命令冲突时内置命令保留。

**本阶段总结应回答**：为什么 Markdown 命令属于 `prompt`，而不是 `local`？

## 第 4 阶段：InputBox 命令补全

**目标**：在真实的 `src/tui/input-box.tsx` 中实现 `/` 菜单与键盘交互。

**实现内容**：

- 输入首字符 `/` 时展示来自 Registry 的候选。
- 先实现主名与别名的大小写不敏感前缀匹配；再根据依赖决策补充模糊匹配。
- 空输入按“最近使用 + 字典序”排列；输入空格后隐藏菜单，因为用户正在填写参数。
- 上下键循环选择；Enter/Tab 仅补全；ESC 关闭但保留文字；多行时不展示。
- 菜单放在输入框下方、状态栏上方，不能遮挡权限模式行。

**完成标志**：补全和提交是两次独立动作；零候选时不会把未知命令误发给 Agent。

**风险点**：InputBox 目前是单行 `value + cursor` 状态；实现前先确认是否要扩展成多行，不能直接照旧规划中的 `lines` 状态复制。

## 第 5 阶段：App dispatcher 与现有命令迁移

**目标**：在 `src/tui/app.tsx` 增加一个统一的 `handleSlashCommand()`，将现有硬编码分支逐项迁移。

**实现内容**：

- `submit()` 先调用 dispatcher；返回“已消费”时不进入普通用户消息路径。
- `local` 输出 system message，不写 session、不发 LLM。
- `local_ui` 在 App 内执行动作，例如清空、切模式、恢复会话、回滚、退出、压缩。
- `prompt` 使用和普通用户输入完全一致的路径：消息列表、Conversation、JSONL、Agent loop。
- 未命中显示 `Unknown command: /name`，不送给 LLM。
- 迁移 `/mcp` 时保持现有约定：默认不展示 MCP 工具，只在显式 `/mcp` 时展示。

**完成标志**：`App.submit()` 不再为每个命令保存单独的正则分支；但真正依赖实时状态的动作仍留在 App，不被 Registry 反向依赖。

**本阶段总结应回答**：为什么 `/review` 必须走 user message 路径，而 `/status` 不能走？

## 第 6 阶段：扩展接口与阶段验收

**目标**：确认后续章节可以注册命令，同时完成本章最终验收。

**实现内容**：

- 提供 Registry 的外部注册入口及冲突诊断；第十、十三、十四章只能从这里接入。
- 补齐本章测试：Registry、解析、loader、usage tracker、dispatcher 和 InputBox 关键键位。
- 最后统一跑全量测试、类型检查、构建和真实 TUI 冒烟。
- 根据最终代码生成 Debug、Interview 文档；不得提前编造函数行号或测试数字。

**完成标志**：命令核心不导入未来的 Skills、Worktree、Team 模块；帮助、补全和分发读取同一个 Registry 实例。

## 建议开发顺序

```text
第 1 阶段 Registry/parse
  -> 第 2 阶段 默认命令/usage
  -> 第 3 阶段 用户命令 loader
  -> 第 4 阶段 InputBox 补全
  -> 第 5 阶段 App dispatcher 迁移
  -> 第 6 阶段 扩展接口与最终验收
```

开发过程中按你的约定：每个阶段只做代码和必要的 lint / prettier；不创建或运行 `*.test.*`。第六阶段才补测试并跑完整验收。
