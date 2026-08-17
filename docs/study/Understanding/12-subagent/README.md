# 第 12 章开发前理解：SubAgent 是什么

## 先看一个真实问题

主 Agent 收到任务：

> 先阅读这个仓库，找出登录模块的风险；同时给我一个修改方案。

如果让同一个 Agent 一边阅读几十个文件、一边思考风险、一边写方案，所有草稿、工具结果和临时判断都会进入同一段对话。上下文会越来越杂，模型也容易把“探索时的猜测”误当成最终结论。

SubAgent 的做法是：主 Agent 把一个边界清楚的小任务交出去，例如“只审查登录模块，不要修改文件”。子 Agent 独立完成后，只把一份短结果交回主 Agent。

```text
主 Agent：我要解决完整问题
  └─ 子 Agent：我只做“审查登录模块”
       └─ 返回：发现的风险、证据、建议
主 Agent：把子结果和自己的上下文合并，回答用户
```

## SubAgent 不是线程，也不是新进程

这一章的 SubAgent 是应用内部新建的一套 Agent 对象，不是 Node.js Worker，不会自动拥有独立内存或独立文件系统。

它真正隔离的是运行状态：

- 新的 `Conversation`：看不到主对话的完整来回；
- 新的 `PermissionChecker`：不会继承“本轮已经允许”的可变状态；
- 新的取消信号、轮次上限和 token 统计；
- 新的工具注册表“视图”：只看到允许的工具。

它仍会使用同一个工作目录。这是本章的明确边界；第 13 章才通过 Worktree 处理并发读写文件的隔离。

## 为什么不能让子 Agent 再派子 Agent？

如果每个子 Agent 也能继续创建子 Agent，任务数量会像树一样增长：一个任务派三个、每个再派三个，很快就会消耗大量 token、网络请求和本机资源。

所以第 12 章固定深度为 1：主 Agent 可以调用 `Agent` 工具，子 Agent 永远看不到这个工具。这不是靠提示词要求，而是从它的工具注册表中移除。

## 同步与后台是什么意思？

同步任务像普通函数调用：主 Agent 发起后等待结果，拿到总结后才能继续回答。

后台任务像“先登记，稍后取结果”：主 Agent 立即得到 taskId，可以继续当前对话；后台完成后，`TaskManager` 只注入一次简短通知。用户或模型可以查询任务状态，也能取消任务。

```text
同步：AgentTool -> Runner.run() -> 等结果 -> ToolResult

后台：AgentTool -> TaskManager.create() -> taskId
                           └─ Runner.run() -> 完成通知（一次）
```

## 这一章最终要做什么

1. 定义角色，例如 `general-purpose`、`plan`、`explore`。
2. 从内置、用户、项目三个层级加载角色定义，后面的同名定义覆盖前面。
3. 为角色生成“可用工具视图”，而不是修改主 Agent 的注册表。
4. 用 `SubAgentRunner` 创建独立 Agent 并收集最终结果。
5. 用 `TaskManager` 管理后台任务的创建、完成、失败、取消和通知。
6. 用一个模型可调用的 `Agent` 工具把同步/后台两条路径接回主 Agent 与 TUI。

## 本章不做什么

- 不做 Team、队员互相通信或长驻队员；这些属于第 14 章。
- 不自动创建 Worktree；这些属于第 13 章。
- 不允许子 Agent 再派子 Agent。
- 不让角色覆盖 `api_key`、`base_url` 等 Provider 凭据。

读代码时，先抓住一条主线即可：

```text
AgentTool.execute()
  -> SubAgentRunner.run()
  -> new Agent(...).run()
  -> Provider.stream()
  -> 只把 finalText 返回主 Agent
```

先理解“为什么要隔离”和“最终只交回摘要”，再进入每个类的实现细节。
