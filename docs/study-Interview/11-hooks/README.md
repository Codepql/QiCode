# 第 11 章 Interview：Hook 生命周期系统

## 1. 你如何向面试官解释 Hook？

Hook 是挂在既定生命周期节点上的“事件、条件、动作”规则：到了某个事件，条件匹配，就执行动作。

例如用户让 Agent 修改 `.env`：模型准备调用 `WriteFile`，系统在真正执行前触发 `pre_tool_use`；如果规则发现目标是 `.env`，就返回拒绝，模型收到一个失败的 ToolResult，文件保持不变。

它不是普通工具：工具是模型主动选择的能力，Hook 是系统在关键节点自动运行的控制点。它也不是 Skill：Skill 主要提供上下文和工具限制，Hook 负责生命周期控制和审计。

## 2. 为什么配置加载和 Hook 校验分开？

`loadConfigLayers()` 解决的是“从哪些文件读取、按什么顺序合并”。`validateHooks()` 解决的是“这一条规则是否符合 Hook 语义”。

分开后，配置层可以保留原始输入，坏 Hook 只生成带索引的诊断，不会阻止其他合法 Hook 继续工作。这也避免 YAML 解析器、Provider 校验和 Hook 语义互相耦合。

## 3. 为什么 HookEngine 必须由 App 共享？

`HookEngine` 持有三类运行时状态：`firedOnce` 去重集合、通知队列、异步任务集合。如果每一轮 `submit()` 新建 Agent 并新建引擎，`once: true` 会在每轮重新触发，异步通知也无法跨轮传递。

因此 App 用 `useMemo()` 按配置和工作目录创建一个引擎，所有 Agent 只引用它。`/clear` 只清 Conversation，不能重置 Hook 的进程级状态。

## 4. Hook 事件顺序是什么？

一次 `Agent.run()` 的核心顺序是：

```text
session_start
  turn_start
  pre_send
  drain notifications -> 临时 reminder
  Provider.stream
  post_receive
  Skill filter
  pre_tool_use
  PermissionChecker
  tool execute
  post_tool_use
  turn_end
session_end (finally)
```

`session_end` 放在 `finally`，覆盖正常完成、取消、上下文错误和 Provider 异常。

## 5. 为什么 pre_tool_use 放在 PermissionChecker 前面？

两者职责不同。PermissionChecker 决定“这个工具调用在当前权限模式下能否执行”；pre-tool Hook 决定“即使权限允许，这类调用是否还满足业务规则”。

Hook 只能增加拒绝条件，不能产生 Allow。这样既不会让 Hook 绕过权限，也能保证 Hook 拒绝时工具根本不会进入 `StreamingExecutor.submit()`。

## 6. Command Hook 为什么还要经过权限链？

Hook 配置来自本地文件，但 command 字符串仍然是外部输入面：它可能来自项目配置、复制的规则或被篡改的文件。如果 Hook 自己直接 `spawn`，就形成第二套权限系统。

现在 `Agent.executeHookCommand()` 用逻辑工具名 `HookCommand` 调用 `PermissionChecker.check()`，Ask 复用 TUI 的 `onPermissionRequest()`，永久允许复用 `allowAlways()`，通过后才调用 `BashTool.execute()`。安全规则因此只有一个入口。

## 7. 为什么异步 Hook 遇到 Ask 必须拒绝？

异步 Hook 的定义是不阻塞当前轮。如果它遇到 Ask，却继续等待用户，就会在后台任务里弹出一个与当前输入不对应的权限请求，造成竞态甚至误授权。

所以 `HookContext.background` 会标识异步动作；`authorizeHookAction()` 遇到 Ask 直接返回拒绝。Allow 或明确 Deny 仍可立即处理。

## 8. 为什么 Hook prompt 不写入 Conversation？

Hook prompt 是运行时控制信息，不是用户和模型共同形成的长期对话事实。如果持久化，会出现重复注入、上下文膨胀和 session 恢复后语义改变。

Agent 只把它包装为本次请求的 `systemReminderMessage()`，再通过 `applyBudget()` 一起参与本次上下文预算；`Conversation` 和 session JSONL 保持干净。

## 9. HTTP Hook 如何防 SSRF？

只检查 URL 是 HTTPS 不够，因为域名解析后可能指向私网，也可能通过重定向跳进内网。`fetchSafeText()` 在每一跳检查协议、凭据、全部 DNS 地址、loopback 例外、响应大小和超时。

它还明确保留 DNS 检查与实际连接之间的 TOCTOU 限制，没有声称实现绝对防护。`HookHttpActionExecutor` 只发送固定字段的 JSON body，不允许配置任意 headers 或 shell 参数。

## 10. 本章测试证明了什么？

本章验收共 `38` 个测试文件、`222` 条测试：

- 配置层 Hook 按层追加；坏规则不影响好规则；
- 条件表达式支持路径 glob；
- `once`、通知队列和 pre-tool reject；
- Agent 拒绝 Hook 时工具实现调用次数为零；
- prompt Hook 出现在 Provider 请求中，但不进入 Conversation；
- TUI 把错误显示为本地诊断；
- 全量 typecheck 和 build 通过。

面试时不要只说“我加了 Hook”。更有价值的表达是：我把 Hook 拆成配置契约、纯条件求值、带状态的引擎、受控动作执行器和 Agent 生命周期接入；副作用动作仍统一经过权限检查，提示型 Hook 只存在于请求级上下文，避免污染会话历史。
