# 06-MCP Interview 学习文档：把"外部工具"讲成"统一 Tool 边界内的可发现能力"

> 本文基于第 06 章当前代码。`npx tsc --noEmit` 报 2 处错误，均在 `tests/tui/app.test.tsx`（`App` 尚未接受 `mcpServers`/`mcpManagerFactory` 属性）；`npx vitest run` 记录为 30 个测试文件、165 个用例，其中 163 通过、2 失败（均为 App 级 MCP 接线的占位测试，超时）。MCP 协议层、Registry 延迟加载与权限接入的单测全绿。真实终端的 stdio/HTTP server 冒烟按 Debug 文档实验验证。

## 1. 30 秒项目介绍

```text
QiCode 是一个用 TypeScript 写的终端 Coding Agent。第 06 章解决的是"工具写死在代码里、无法接入外部生态"的问题：要接 GitHub、数据库或内部服务，不该每加一个就改一次核心。

我引入 MCP：配置声明外部 server，官方 SDK 完成 transport 与握手，远端工具被包装成统一 Tool，命名成 mcp__server__tool，默认 deferred 不进 schema；模型先用 ToolSearch 检索、select 激活，下一轮才看到 schema。调用时 MCP 工具固定按 command 类走第五章权限护栏，Agent 和 Provider 都不需要知道工具来自本地还是远端。
```

## 2. 两分钟讲法

```text
难点不是调 SDK 方法，而是四种状态同时存在：配置状态、连接状态、工具发现状态、工具激活状态。我把它们拆成四条链路分开管。

配置链：YAML 解析出 MCPServerConfig，三层文件按 name 合并（同名后层整体替换，不是字段级拼接——否则会把命令来自项目层、凭据来自用户层拼成畸形对象）。凭据只在连接边界展开 env/header 里的 ${VAR}、$VAR，未定义变量替成空串，不写回配置对象。

连接链：MCPClient 封装单个 server 生命周期，用官方 SDK 的 StdioClientTransport / StreamableHTTPClientTransport / SSE（惰性加载），完成 initialize、listTools、callTool、getInstructions、disconnect。不在项目内自研 JSON-RPC。

管理链：MCPManager 维护 Map<serverName, MCPClient>，顺序连接、逐个 try/catch，返回 servers/tools/errors/instructions 四类结果——一个 server 失败不会让全局 Promise.all 拉垮，错误被收集并展示，成功 server 仍可用，这是"部分成功"语义。

工具链：MCPToolWrapper 是适配器，把远端 {name,description,inputSchema} 转成项目 Tool，category 固定 command、deferred=true，execute 把异常转成 isError 的 ToolResult 不抛回 Agent Loop。远端调用名（create.issue）和暴露名（mcp__git_hub_team__create_issue）分离，非法字符替成 _，保留来源可追溯。

发现链：Registry 区分 registered 与 discovered。未激活的 deferred 工具存在但不进 listToolsForModel。ToolSearch 有两种语义——关键词只返回名+短描述、不改状态；select:<name> 精确激活并返回 schema。激活不立即改当前请求，只影响下一轮 schema，否则一次模糊搜索就把几百个工具全暴露。

接入点：Agent 的 toolDefinitions() 从 listTools() 换成 listToolsForModel()，这是真正发给 Provider 的 schema 来源，改未被调用的 getAllSchemas() 无效。MCP 工具按 command 类自然进入第五章权限链，不需要改 checker.ts。
```

我诚实说明边界：本章只做 MCP tools，不做 resources/prompts/sampling/OAuth/自动重连/热加载；App 级生命周期接线（启动连接、/mcp、/status、instructions 注入、把 ToolSearch 注册进会话级 Registry）尚未落地，两个 App 测试目前失败；Bash 命令黑名单不保护 MCP 工具，远程 server 的网络安全不由 client 解决。

## 3. 面试架构图

```text
YAML 三层合并 (load-config.ts)
        |
        v
MCPManager.connectAll()                 src/mcp/manager.ts:20
  逐个 try/catch -> MCPClient.connect()
                                   src/mcp/client.ts:41
     transport(stdio|http|sse) -> SDK Client.connect()
     listTools() -> getInstructions()
        |
        v  成功工具
MCPToolWrapper(client, server, tool)    src/mcp/tool-wrapper.ts:8
  name = mcp__<server>__<tool>          deferred=true, category=command
  schema() 原样透传 inputSchema
        |
        v
ToolRegistry.register(wrapper)          src/tools/registry.ts:9
  -> #tools 有，但 listToolsForModel() 过滤掉 deferred 未激活
        |
        v
Agent.toolDefinitions()                 src/agent/agent.ts:333
  用 listToolsForModel() 生成发给 Provider 的 schema
        |
   模型 ToolSearch(query) -> 候选名（不激活）
        |
   模型 ToolSearch("select:mcp__s__t") -> markDiscovered
        |
        v  下一轮
listToolsForModel() 含已激活工具 -> 模型看到 schema
        |
   tool_use(mcp__s__t)
        |
        v
PermissionChecker.check(name,"command") -> 默认 ask / bypass allow
        |
        v  批准
MCPToolWrapper.execute() -> MCPClient.callTool(远端名) -> 聚合 content -> ToolResult
```

讲图时强调：**四条链路各有所有权**——配置属于加载器、连接属于 Client、生命周期属于 Manager、暴露规则属于 Registry；MCP 协议细节止步于 wrapper，Agent 与权限系统只看到一个 command 类 Tool。

## 4. 高频问题

### Q1. MCP 解决的是工具协议、发现还是权限问题？

**关键词**：协议无关、发现、不改权限。

```text
三者都沾边但核心是"协议无关的统一 Tool"。MCP 定义了外部 server 怎样被发现和调用；延迟加载解决工具数量噪声；权限不变——MCP 工具复用第五章 command 类决策，不新增 checker 分支。
```

证据：[tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:11)（`category = "command"`）与 [tool-wrapper.test.ts](../../../../tests/mcp/tool-wrapper.test.ts:66)（复用既有 command 策略）。

### Q2. 为什么必须用官方 SDK，而不是自己写 JSON-RPC？

**关键词**：握手、transport、协议演进。

```text
MCP 协议涉及 initialize 握手、capability 协商、request/response 配对、stdio/HTTP/SSE 三种 transport 和版本演进。自研 JSON-RPC 要持续跟进协议，易错且无收益。SDK 把这些细节封装成 Client.connect/listTools/callTool，我们只负责生命周期和适配。
```

证据：[client.ts](../../../../src/mcp/client.ts:45) 用 SDK `Client`，[client.ts](../../../../src/mcp/client.ts:1) 导入官方 transport。

### Q3. MCPClient、MCPManager、MCPToolWrapper 各自拥有什么状态？

**关键词**：协议会话、生命周期、适配。

```text
MCPClient 拥有一个 server 的 transport 和 SDK Client（connect/listTools/callTool/disconnect）。MCPManager 拥有 Map<serverName, MCPClient> 与批量连接/失败收集/统一断开。MCPToolWrapper 拥有远端名、inputSchema 副本和到 Client 的引用，负责把远端调用结果聚合成 ToolResult。三者职责不重叠：Client 不注册 Tool，Manager 不决定权限，Wrapper 不持有连接。
```

证据：[client.ts](../../../../src/mcp/client.ts:29)、[manager.ts](../../../../src/mcp/manager.ts:13)、[tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:8)。

### Q4. 为什么一个 server 失败不能阻止其他 server？

**关键词**：部分成功、失败隔离、不用 Promise.all。

```text
外部 server 可能不存在、启动失败或协议不兼容。若用 Promise.all，一个 reject 全军覆没。Manager 在 for 循环里逐个 try/catch：失败 server disconnect 并进 errors，成功 server 仍 set 进 #clients、工具仍进 tools。这是"部分成功"的编排层，不是全成全败。
```

证据：[manager.ts](../../../../src/mcp/manager.ts:31) 的 try/catch 与 [manager.test.ts](../../../../tests/mcp/manager.test.ts:26) 的三 server部分成功用例。

### Q5. 为什么 server/tool 名需要命名空间？

**关键词**：冲突、来源追踪、权限定位。

```text
多个 server 都可能提供 search/list/create。统一成 mcp__server__tool 同时解决冲突、来源追踪和权限规则定位：mcp__github__* 可直接成为第五章 glob 规则的匹配对象。MCP 层不修改权限代码，因为权限只依赖统一工具名和类别。
```

证据：[tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:4) 的 `toMcpToolName` 与 [tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:51) 的 `sanitizePart`。

### Q6. registered 和 discovered 有什么区别？

**关键词**：已注册、已暴露、schema 过滤。

```text
registered 表示工具已连上、可调用、存在于 Registry；discovered 表示已激活、已暴露给模型。未激活的 deferred 工具仍存在于 #tools，但 listToolsForModel 用 `!deferred || discovered.has(name)` 过滤掉，不进发给 Provider 的 schema。
```

证据：[registry.ts](../../../../src/tools/registry.ts:22) 的 `listToolsForModel` 与 [registry.ts](../../../../src/tools/registry.ts:56) 的 `markDiscovered`。

### Q7. 为什么关键词搜索不能直接激活工具？

**关键词**：探索 vs 激活、噪声、状态分离。

```text
关键词搜索是探索行为，只返回名+短描述，不改状态；select 是精确激活。若模糊搜索就激活，一次查询可能把几百个工具全部塞进 schema，造成上下文成本和选择噪声。两个动作必须分开，激活后还要等下一轮 schema 才生效。
```

证据：[tool-search.ts](../../../../src/tools/tool-search.ts:53)（关键词不调 markDiscovered）与 [tool-search.ts](../../../../src/tools/tool-search.ts:79)（select 才 markDiscovered）。

### Q8. 为什么 select 激活后要等下一轮 schema？

**关键词**：已发请求不可变、下一轮生效。

```text
激活改的是 Registry 的 discovered 集合，而当前轮的 Provider 请求已经构造完发出去。markDiscovered 只影响下一次 toolDefinitions() 调用——下一轮 Agent 重新生成 schema 时，已激活工具才真正暴露给模型。
```

证据：[agent.ts](../../../../src/agent/agent.ts:336) 的 `listToolsForModel()` 在每轮 toolDefinitions 重新求值；[agent.test.ts](../../../../tests/agent/agent.test.ts:27) 验证 markDiscovered 后下一轮才出现。

### Q9. 为什么 App 不能每轮新建 Registry？

**关键词**：会话级状态、discovered 丢失、生命周期。

```text
若每轮重建 Registry，已激活工具下一轮消失、wrapper 丢失、discovered 集合清空，ToolSearch 的激活语义直接作废。Registry、MCPManager、discovered 集合必须属于同一个会话，放进 App 的 ref/state，卸载时 disconnectAll。（当前 App 尚未做此接线，这是已知 gap。）
```

证据：当前 [app.tsx](../../../../src/tui/app.tsx:255) 仍每轮 `createToolRegistry()`，且 [app.tsx](../../../../src/tui/app.tsx:402) 的 `createToolRegistry` 未注册 ToolSearch——App 级接线是第 7 次开发的未完成项。

### Q10. MCP 工具为什么按 command 类进入第五章权限链？

**关键词**：副作用不可静态分析、保守分类、不改 checker。

```text
远端工具可能对数据库、网络或第三方 API 产生副作用，且 client 无法静态解析远端参数中的文件路径。统一按 command 类最易解释：default/acceptEdits 模式 ask，bypass 模式 allow，显式规则可按完整名匹配。这样权限层不需要知道 transport 类型，MCP 层不需要新建权限分支。
```

证据：[tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:11) `category = "command"`；[tool-wrapper.test.ts](../../../../tests/mcp/tool-wrapper.test.ts:66) 断言 default=ask、bypass=allow 走既有分支。

### Q11. 环境变量展开为什么只能发生在连接阶段？

**关键词**：凭据边界、不落盘、命名空间不展开。

```text
凭据应只在连接边界进入 transport，不能写回 YAML 或进日志。expandEnv 只作用于 env/header 的值，server 名、工具名、command、args 都不展开，未定义变量替成空串，原始 config 对象被 clone 不修改。这样 token 不会渗进配置层或错误消息。
```

证据：[client.ts](../../../../src/mcp/client.ts:20) 的 `expandEnv`、[client.ts](../../../../src/mcp/client.ts:143) 的 `expandRecord`（只对 env/header）、[client.ts](../../../../src/mcp/client.ts:197) 的 `cloneConfig`；[client.test.ts](../../../../tests/mcp/client.test.ts:6) 验证 `${TOKEN}`、`$TOKEN`、`$MISSING`→空。

### Q12. 远端调用异常为什么不抛回 Agent Loop？

**关键词**：结构化错误、自我修正、保续。

```text
抛异常会中断 Agent Loop。MCPToolWrapper.execute 捕获 callTool 异常，返回 { output: "MCP tool error: <msg>", isError: true }，作为该工具调用的结果进历史。模型据此知道远端失败、换路径继续，和第五章 deny 回灌语义一致。
```

证据：[tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:42) 的 try/catch 与 [tool-wrapper.test.ts](../../../../tests/mcp/tool-wrapper.test.ts:49)。

## 5. 深挖追问

| 追问 | 回答方向 |
| --- | --- |
| 三层合并为什么按 name 整替而不是字段拼接？ | 字段拼接会把命令来自项目层、凭据来自用户层拼成畸形对象；按 name 整替保证一个 server 的字段来自同一层，cloneMcpServer 防泄漏引用。 |
| 为什么 listTools 不做缓存？ | server 工具集在连接后相对稳定，但 MCP 允许动态变化；当前每次连接触发一次 listTools，不跨轮缓存，是简单与正确之间的保守取舍。 |
| SSE transport 为什么惰性加载？ | SSE 是兼容旧 server 的 fallback，惰性 import 把废弃 SDK 符号排除在默认 Streamable HTTP 路径外，减少默认包体与启动开销。 |
| content 数组怎么聚合？ | 按 type==="text" 取 .text，其它 JSON.stringify，用 \n 连接；空 content 回退到 serialize(result)，保证非标准返回也不崩。 |
| markDiscovered 对非 deferred 工具有效吗？ | 无效。markDiscovered 内部 `if (#tools.get(name)?.deferred === true)` 才加；普通工具本来就暴露，无需也无需激活。 |
| 注册一个同名 deferred 工具会怎样？ | register 用 Map.set 覆盖；若新工具非 deferred，会从 discovered 删掉，立即暴露——这是"激活态随工具重注册修正"的语义。 |
| connect 失败后 transport 泄漏吗？ | 不泄漏。connect catch 里置空 client/transport，并 transport.close().catch(() => {})，保证失败不残留连接。 |
| App 接线缺失会怎样？ | 当前 App 每轮重建 Registry、未注册 ToolSearch、不接受 mcp 属性，所以两个 App 测试超时失败；这是第 7 次开发的未完成项，协议层单测不受影响。 |

## 6. 简历表达

```text
QiCode | TypeScript, Node.js, MCP SDK
- 设计 MCP 外部工具接入：三层 YAML 按 name 合并 MCPServerConfig，官方 SDK 完成 stdio/Streamable HTTP/SSE 三种 transport 的握手与调用，凭据仅在连接边界展开 env/header。
- 实现 MCPManager 失败隔离：顺序连接逐个 try/catch，返回 servers/tools/errors/instructions 四类结果，单 server 失败不阻断其他 server（部分成功语义）。
- 用 MCPToolWrapper 把远端工具适配为统一 Tool（mcp__server__tool 命名、category=command、deferred），异常转 isError 的 ToolResult 回灌模型，复用既有权限链零新增分支。
- 实现 ToolRegistry 延迟加载与 ToolSearch 双语义（关键词检索不激活 / select 精确激活下一轮暴露），Agent toolDefinitions 切到 listToolsForModel 控制暴露面。
```

不要写：

- "完整 MCP 集成已上线"——App 级接线未完成，两个集成测试失败。
- "自动重连与热加载"——本章不做。
- "MCP 工具的权限安全完备"——Bash 黑名单不覆盖 MCP，远程安全不由 client 解决。

## 7. 推荐学习顺序

1. 先读 [Understanding 文档](../Understanding/06-mcp/README.md) 建立四链路心智模型。
2. 阅读 [Debug 文档](../Debug/06-mcp/README.md) 的架构地图与断点路线。
3. 沿 [load-config.ts](../../../../src/config/load-config.ts:169) 的 `parseMcpServers`/`mergeMcpServers` 看三层合并。
4. 读 [client.ts](../../../../src/mcp/client.ts:41) 的 `connect` 与 [client.ts](../../../../src/mcp/client.ts:105) 的 `#createTransport`。
5. 读 [manager.ts](../../../../src/mcp/manager.ts:20) 的 `connectAll` 看失败隔离。
6. 读 [tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:8) 与 [registry.ts](../../../../src/tools/registry.ts:22) 看 deferred/discovered。
7. 读 [tool-search.ts](../../../../src/tools/tool-search.ts:40) 的双语义 execute。
8. 跑 `npx vitest run tests/mcp tests/tools/tool-search.test.ts tests/tools/registry.test.ts` 并临时把 `selectTools` 的 `markDiscovered` 注释掉观察激活失效。
9. 脱稿回答 Q2、Q4、Q6、Q7、Q8、Q10、Q11。

## 8. 独立练习

给 `ToolSearchTool` 增加一个"已激活工具列表"子命令（如 `query="list"`），返回当前 `discovered` 集合中的工具名，并回答：

- 这个命令应该是只读还是改变状态？为什么？
- 如果允许 `deselect:<name>` 取消激活，Registry 需要补哪个方法？会不会破坏当前轮已发出的请求？
- 用 `tests/tools/tool-search.test.ts` 加一个用例证明你的实现不影响既有 select 语义。
