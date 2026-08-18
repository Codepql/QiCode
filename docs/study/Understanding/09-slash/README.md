# 09-Slash Start：开发前理解

## 背景：现在的命令为什么会越来越难维护？

QiCode 的输入框只有一个出口：用户按回车后，`App.submit()` 判断这段文字应该交给 Agent，还是本地直接处理。

目前已经有 `/plan`、`/do`、`/memory`、`/mcp`、`/rewind`、`/resume`、`/compact`、`/permission` 等命令。它们都写在同一个 `submit()` 函数里：一个命令就是一段 `if` 或正则分支。

这在命令很少时没有问题，但继续加入 `/help`、`/status`、`/review`、用户自定义命令，以及第十章以后的 `/skills`，会出现三个问题：

```text
命令名字和别名散在 App 中       -> 不知道哪些名字已经被占用
命令说明散在 App 中             -> 无法自动生成 /help 和补全菜单
本地命令和发给 LLM 的命令混在一起 -> 容易让“查看状态”也消耗 token
```

第九章的目标不是让 Agent 更聪明，而是给 TUI 增加一条稳定的“本地控制通道”。用户输入 `/` 开头的内容时，系统先尝试命令分发；只有真正需要模型处理的提示词命令，才进入原来的 Agent 回合。

## 完成后，输入会走哪条路？

```text
用户输入
  |
  +-- 普通文字 ------------------------> user message -> Conversation -> Agent -> LLM
  |
  +-- /status、/help、/memory ----------> 本地计算 -> system message -> 显示结果
  |
  +-- /clear、/plan、/resume、/rewind --> 本地动作 -> 修改 TUI / 会话状态
  |
  +-- /review、/自定义命令 -------------> 生成 user prompt -> 走普通 Agent 链路
  |
  +-- /不存在的命令 --------------------> 显示 Unknown command，不发给 LLM
```

这里最重要的区分是：

- `local`：只读本地状态，例如 `/help`、`/status`。不写会话、不调用 LLM。
- `local_ui`：改变程序自身状态，例如 `/clear`、`/plan`、`/resume`。仍然不调用 LLM。
- `prompt`：把命令转换成一段真正的用户任务，例如 `/review`。它必须和普通用户消息走完全相同的存档、上下文和 Agent 流程。

## 本章要建立的四个部件

### 1. CommandRegistry：命令通讯录

Registry 保存命令的名字、别名、描述、类型和处理函数。

它负责回答：`/c` 是不是 `/compact`？`/help` 是否已被注册？用户命令能否覆盖内置命令？输入 `/sta` 时哪些命令可以补全？

注册时必须检查四类冲突：主名和主名、主名和别名、新别名和主名、新别名和别名。这样命令冲突会在启动时暴露，而不是用户输入时才出现奇怪行为。

### 2. Dispatcher：把命令结果接回真实程序

Registry 不应该直接依赖 React state、Ink 的 `exit()` 或 `Conversation`。它只返回文本或动作标识。

`App` 里的 dispatcher 才拥有运行时状态，因此由它决定：文本显示成 system message、`clear` 应清掉哪些状态、`review` 应如何写入 JSONL 并启动 Agent。这让命令核心可以单独测试，也为第十、十三、十四章注册新命令留下接口。

### 3. InputBox：用户如何发现命令

输入第一个 `/` 后，InputBox 从同一个 Registry 获取候选，显示菜单；输入命令名时按名称、别名和描述排序；方向键选择，Enter 或 Tab 只把 `/<name> ` 写回输入框，而不是立即执行。

补全菜单只是编辑辅助，不负责调用命令。真正执行仍然只发生在用户再次按回车提交后。

### 4. 用户自定义命令与使用记录

Markdown 文件可被加载成 prompt 命令。例如项目中的 `.QiCode/commands/review-api.md` 可以成为 `/review-api`。它不能覆盖内置命令，单个坏文件也不能阻断其他命令。

使用频次记录只影响空 `/` 时的菜单排序，不影响命令权限，也不改变实际分发规则。

## 本章不做什么？

- 不新增命令级权限系统；真正的工具执行仍走第五章 PermissionChecker。
- 不让 `/status`、`/memory` 这类本地查询调用 LLM。
- 不在本章实现未来的 `/skills`、`/worktree`、`/code-review` 功能，只提供注册入口。
- 不做自定义命令热加载；改文件后重启 TUI 才会生效。

## 开发前只要记住一句话

第九章不是“给 Agent 加斜杠命令”，而是把输入入口分成三条有明确副作用边界的路径。以后新增功能时，应注册命令，而不是继续往 `App.submit()` 叠加 `if (command === ...)`。
