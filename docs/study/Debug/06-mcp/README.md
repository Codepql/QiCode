# 06-MCP Debug 学习文档：跟踪外部工具从配置到暴露的四状态流转

> 适用代码：QiCode 第 06 章当前实现。`npx tsc --noEmit` 报 2 处错误，均在 `tests/tui/app.test.tsx`（`App` 尚未接受 `mcpServers`/`mcpManagerFactory` 属性）；`npx vitest run` 记录为 30 个测试文件、165 个用例，163 通过、2 失败（均为 App 级 MCP 接线占位测试，超时）。MCP 协议层、config 三层合并、Registry 延迟加载、ToolSearch、wrapper 权限接入单测全绿。真实终端的 stdio/HTTP server 冒烟仍需手工验证。

## 1. 本章解决了什么

第 05 章之后，工具执行已有权限护栏，但**工具写死在 `createToolRegistry()` 里**：要接 GitHub、数据库或内部服务，就得改核心代码。第 06 章把"写死的内置工具"扩展成"配置驱动的外部工具生态"，核心是四种状态的同时管理：

```text
配置状态   YAML -> MCPServerConfig -> 三层按 name 合并
连接状态   MCPManager.connectAll -> MCPClient.connect/listTools
发现状态   ToolRegistry deferred vs discovered
激活状态   ToolSearch select -> markDiscovered -> 下一轮 schema
```

四个词概括本章：**协议无关、部分成功、注册不等于暴露、激活改下一轮**。MCP 协议细节止步于 `MCPToolWrapper`，Agent 与权限系统只看到一个 `category="command"` 的统一 Tool。

## 2. 架构地图

```text
src/config/types.ts                 # MCPServerConfig / AppConfig.mcp_servers
src/config/load-config.ts           # 三层合并 + mcp_servers 字段校验 + env 不展开
src/mcp/client.ts                  # 单 server 会话：transport 选择 / expandEnv / 聚合 content
src/mcp/manager.ts                 # 多 server：失败隔离 / 部分成功 / disconnectAll
src/mcp/tool-wrapper.ts            # 适配器：mcp__server__tool / deferred / 异常转 ToolResult
src/tools/tool-search.ts           # system 只读工具：关键词检索 vs select 激活
src/tools/registry.ts              # deferred/discovered + listToolsForModel
src/tools/types.ts                 # Tool.deferred? / Tool.system?
src/agent/agent.ts                 # toolDefinitions 切到 listToolsForModel
tests/mcp/*.test.ts                # client / manager / wrapper 单测（含真实 stdio fixture）
tests/tools/tool-search.test.ts    # 双语义 + 不激活证明
tests/fixtures/mcp-stdio-server.mjs # 真实 echo server（instructions + image content）
```

调用链按阶段拆开。每步都标出**文件夹（模块）→ 文件 → 函数**三段对应关系：`模块 / 文件:行 / 函数()`。`[已落地]` 表示协议层代码已实现且单测覆盖，`[未接线]` 表示该步靠 App 编排、当前 App 尚未实现（详见 D7）。

文件夹→职责速查（本章涉及的 6 个模块）：

```text
src/config/        配置解析：三层合并、字段校验、env 不在此展开
src/mcp/           MCP 协议：client(单 server 会话) / manager(多 server 编排) / tool-wrapper(适配器)
src/tools/         工具系统：registry(deferred/discovered) / tool-search(发现与激活)
src/agent/         编排：toolDefinitions 决定真正发给 Provider 的 schema
src/permissions/   权限：MCP 工具复用第五章 checker，无新增分支
src/tui/           App 生命周期：[未接线] 启动 connectAll、注册 wrapper、/mcp、卸载 disconnectAll
```

```text
【阶段 A 配置】[已落地]
  文件夹 src/config  /  load-config.ts:74  /  loadConfigLayers()
    读取 ~/.QiCode、<cwd>/.QiCode、<cwd>/.QiCode/config.local.yaml 三层
  文件夹 src/config  /  load-config.ts:370 /  mergeMcpServers()
    同名 server 整替（不是字段拼接）-> AppConfig.mcp_servers[]

【阶段 B 连接】[已落地]
  文件夹 src/mcp  /  manager.ts:20  /  MCPManager.connectAll(configs)
    for config (保持声明顺序、逐个独立 try/catch):
  文件夹 src/mcp  /  manager.ts:17  /  createClient(config)  -> new MCPClient(clone)
  文件夹 src/mcp  /  client.ts:35   /  MCPClient 构造（cloneConfig 防配置引用泄漏）
  文件夹 src/mcp  /  client.ts:41   /  MCPClient.connect()
  文件夹 src/mcp  /  client.ts:105  /  MCPClient.#createTransport()
      command 非空 -> StdioClientTransport；url + transport==="sse" -> 惰性 SSE；其余 url -> StreamableHTTP
  文件夹 src/mcp  /  client.ts:143  /  expandRecord() + client.ts:20 / expandEnv()
      仅 env/header 的值展开 ${VAR}/$VAR；command、args、server 名不展开
  文件夹 src/mcp  /  client.ts:65   /  MCPClient.listTools()  -> [{name,description,inputSchema}]
  文件夹 src/mcp  /  client.ts:61   /  MCPClient.getInstructions()
  文件夹 src/mcp  /  manager.ts:34  /  成功 -> #clients.set(name, client)
  文件夹 src/mcp  /  client.ts:91   /  失败 -> MCPClient.disconnect()；manager.ts:47 收集 errors
  返回 ConnectResult {servers, tools, errors, instructions}  (manager.ts:4)

【阶段 C 注册】[未接线] App 遍历 ConnectResult.tools 做组装
  文件夹 src/mcp  /  tool-wrapper.ts:8   /  new MCPToolWrapper(client, serverName, tool)
  文件夹 src/mcp  /  tool-wrapper.ts:4   /  toMcpToolName()
  文件夹 src/mcp  /  tool-wrapper.ts:51  /  sanitizePart()  非法字符 -> _，名 = mcp__<server>__<tool>
      category="command", deferred=true
  文件夹 src/mcp  /  tool-wrapper.ts:25  /  MCPToolWrapper.schema()  原样透传 inputSchema
  文件夹 src/tools  /  registry.ts:9   /  ToolRegistry.register(wrapper)
  文件夹 src/tools  /  registry.ts:22  /  ToolRegistry.listToolsForModel()  deferred 未激活 -> 过滤掉
  文件夹 src/tools  /  tool-search.ts:10 /  new ToolSearchTool(registry)  system=true 始终可见

【阶段 D 暴露】[已落地]
  文件夹 src/agent  /  agent.ts:333  /  toolDefinitions(registry, checker)
  文件夹 src/agent  /  agent.ts:336  /  调 Registry.listToolsForModel() 生成发给 Provider 的 schema
      第一轮：内置工具 + ToolSearch；MCP 工具 deferred，不在 schema

【阶段 E 发现】[已落地] 模型调 ToolSearch 关键词
  文件夹 src/tools  /  tool-search.ts:40 /  ToolSearchTool.execute()
  文件夹 src/tools  /  tool-search.ts:53 /  Registry.searchDeferred(query, max)
  文件夹 src/tools  /  registry.ts:38  /  ToolRegistry.searchDeferred()  只返回 名+短描述
      -> isDiscovered 仍 false（不调 markDiscovered）

【阶段 F 激活】[已落地] 模型调 ToolSearch select
  文件夹 src/tools  /  tool-search.ts:69 /  ToolSearchTool.selectTools(selection)
  文件夹 src/tools  /  registry.ts:49  /  ToolRegistry.findDeferredByNames(names)  精确匹配 deferred
  文件夹 src/tools  /  registry.ts:56  /  ToolRegistry.markDiscovered(name)  -> #discovered.add
      返回 schema JSON；当前轮请求已发出，不改本次请求

【阶段 G 调用】下一轮 schema 含已激活工具后
  模型 tool_use(mcp__s__t, args)
  文件夹 src/permissions  /  checker.ts  /  PermissionChecker.check(name,"command",args)  复用第五章
      default/acceptEdits=ask，bypassPermissions=allow（无 MCP 专属分支）
  批准后：
  文件夹 src/mcp  /  tool-wrapper.ts:33  /  MCPToolWrapper.execute(args, ctx)
  文件夹 src/mcp  /  client.ts:75  /  MCPClient.callTool(#remoteName, args)  用远端原名
  文件夹 src/mcp  /  client.ts:86  /  content[] 聚合：text 取 .text / 其余 serialize()，\n 连接
  文件夹 src/mcp  /  tool-wrapper.ts:42 /  异常 catch -> {output:"MCP tool error: <msg>", isError:true}
      不抛回 Agent Loop
  -> ToolResult 回灌 Conversation，模型据此继续

【阶段 H 退出】[未接线] App 卸载
  文件夹 src/mcp  /  manager.ts:61  /  MCPManager.disconnectAll()
  文件夹 src/mcp  /  client.ts:91  /  MCPClient.disconnect()  client.close + transport.close
      stdio 子进程随 transport.close 释放，无残留
```

> 阶段 A/B/D/E/F/G 的代码路径已实现且单测覆盖；阶段 C、H 的组装动作本身代码存在（`MCPToolWrapper`、`ToolRegistry.register`、`MCPManager.disconnectAll`），只是 `src/tui/app.tsx` 尚未在启动/卸载时把它们串起来。D1-D6 的断点落在已落地阶段，D7 标注 App 接线缺口。

## 3. 一次调用的数据变化

配一个 stdio echo server，按阶段看数据在每一步的形态变化：

```text
──────── 阶段 A 配置 ────────
A1. YAML 文件（.QiCode/config.local.yaml）：
    mcp_servers:
      - name: echo
        command: node
        args: [server.mjs]
        env:
          SUFFIX: "${SUFFIX}"

A2. loadConfigLayers 三层合并后：
    AppConfig.mcp_servers[0] = {
      name: "echo",
      command: "node",
      args: ["server.mjs"],
      env: { SUFFIX: "${SUFFIX}" }   // 注意：仍是字面量，未展开
    }

──────── 阶段 B 连接 ────────
B1. MCPManager.connectAll([{ name:"echo", ... }]) 开始顺序连接
B2. createClient(config) -> new MCPClient(cloneConfig(config))
    // clone 防止原配置对象被改写

B3. client.connect() -> #createTransport()：
    command 非空 -> 选 StdioClientTransport
    env = { ...process.env(字符串化), SUFFIX: expandEnv("${SUFFIX}") }
    // 此刻 ${SUFFIX} 才展开；command/args/server 名不展开
    -> SDK Client.connect(transport) 完成 initialize 握手

B4. client.listTools() ->
    [{ name:"echo", description:"...", inputSchema:{...} }]

B5. client.getInstructions() ->
    "Use echo to return the supplied message."

B6. 成功 -> #clients.set("echo", client)
    ConnectResult = {
      servers: ["echo"],
      tools:   [{ serverName:"echo", tool:{ name:"echo", ... } }],
      errors:  [],
      instructions: [{ serverName:"echo", text:"Use echo..." }]
    }

──────── 阶段 C 注册 [未接线] ────────
C1. 每个 tool 包成 MCPToolWrapper(client, "echo", tool)：
    name        = "mcp__echo__echo"   // toMcpToolName + sanitizePart
    category    = "command"
    deferred    = true
    #remoteName = "echo"              // 远端原名保留

C2. Registry.register(wrapper)：
    #tools 有 "mcp__echo__echo"，#discovered 无
    -> listToolsForModel() 过滤掉（不进 schema）

C3. ToolSearchTool(registry) 注册：system=true，始终可见

──────── 阶段 D 暴露 ────────
D1. Agent 第一轮 toolDefinitions() -> listToolsForModel()：
    schema = [ 内置6工具, ToolSearch ]   // mcp__echo__echo 不在其中

──────── 阶段 E 发现（模型调 ToolSearch 关键词）────────
E1. 模型 -> ToolSearch({ query:"echo" })
E2. Registry.searchDeferred("echo") -> 命中 mcp__echo__echo
E3. 返回给模型："- mcp__echo__echo: <desc>"
    状态：isDiscovered("mcp__echo__echo") === false   // 未激活

──────── 阶段 F 激活（模型调 ToolSearch select）────────
F1. 模型 -> ToolSearch({ query:"select:mcp__echo__echo" })
F2. Registry.findDeferredByNames([...]) -> 命中
F3. Registry.markDiscovered("mcp__echo__echo") -> #discovered.add
F4. 返回给模型：schema 的 JSON 串
    注意：当前轮请求已发出，本次 schema 不变

──────── 阶段 G 调用 ────────
G1. 下一轮 toolDefinitions() -> listToolsForModel()：
    schema 现在含 mcp__echo__echo

G2. 模型 -> tool_use("mcp__echo__echo", { message:"hi" })

G3. PermissionChecker.check("mcp__echo__echo","command",{message:"hi"})：
    default 模式 -> effect="ask"

G4. 用户批准 -> MCPToolWrapper.execute({message:"hi"})：
    -> client.callTool(#remoteName="echo", {message:"hi"})
    -> 远端返回 content = [
         { type:"text",  text:"hi" },
         { type:"image", data:"AA==", mimeType:"image/png" },
         { type:"text",  text:"from-env" }
       ]
    -> 聚合："hi\n{image JSON}\nfrom-env"
    -> ToolResult { output:"hi\n{...}\nfrom-env", isError:false }

G5. 回灌 Conversation，模型据此继续

──────── 阶段 H 退出 [未接线] ────────
H1. App 卸载 -> MCPManager.disconnectAll()
    -> 各 client.disconnect()：client.close() + transport.close()
    -> stdio 子进程随 transport 关闭被释放
```

对比：`connect` 一个 `command:"no-such-binary"` 的 server 会在 B3 抛错、被 manager catch、进 `ConnectResult.errors`，其他 server 不受影响；远端 callTool 抛错会在 G4 被 wrapper catch，返回 `MCP tool error: <msg>` 的 isError 结果。

## 4. 核心模块四问

| 文件 | 负责什么 | 谁调用它 | 它调用谁 | 为什么需要它 |
| --- | --- | --- | --- | --- |
| `src/config/load-config.ts` | 解析 + 三层按 name 合并 + 字段校验 | main/App（配置阶段） | fs、js-yaml | 把外部 server 声明成有身份的列表对象 |
| `src/mcp/client.ts` | 单 server 协议会话 + transport 选择 + expandEnv + 聚合 content | MCPManager | MCP SDK、fs/process.env | 封装协议细节，不在项目内自研 JSON-RPC |
| `src/mcp/manager.ts` | 批量连接 + 失败隔离 + disconnectAll | App（启动/卸载） | MCPClient | "部分成功"的编排层，单 server 失败不阻断 |
| `src/mcp/tool-wrapper.ts` | 远端工具→统一 Tool 适配 | App（注册阶段） | MCPClient.callTool | 让 Agent/权限只看到 command 类 Tool |
| `src/tools/tool-search.ts` | 发现与激活入口 | Agent（作为工具） | ToolRegistry | 控制 deferred 工具的暴露时机 |
| `src/tools/registry.ts` | registered/discovered + schema 过滤 | Agent、ToolSearch | 无 | 区分"可调用"与"已暴露" |
| `src/agent/agent.ts` | toolDefinitions 用 listToolsForModel | Agent.run | Registry | 真正发给 Provider 的 schema 来源 |

## 5. 关键状态

| 状态 | 正常值 | 作用 |
| --- | --- | --- |
| `MCPServerConfig` | `{name, command?|url?, args?, transport?, headers?, env?}` | 一个 server 的声明；command 决定 stdio，url 决定 http/sse |
| `ConnectResult` | `{servers, tools, errors, instructions}` | Manager 的"部分成功"快照 |
| `MCPClient.#client` | SDK Client \| null | 是否已完成握手；null 时 #requireClient 抛错 |
| `MCPToolWrapper.#remoteName` | 远端原名（如 `create.issue`） | execute 时调回远端，与暴露名分离 |
| `Tool.deferred` | true \| undefined | 是否进 schema 前需激活 |
| `Tool.system` | true \| undefined | 始终暴露的系统工具（ToolSearch） |
| `Registry.#discovered` | Set<string> | 已激活工具名集合 |
| `Registry.#tools` | Map<string, Tool> | 全部已注册工具（含未激活） |

## 6. 推荐断点路线

### D1：配置三层怎么按 name 合并

- 断点：[load-config.ts](../../../../src/config/load-config.ts:370) 的 `mergeMcpServers`，再进 [load-config.ts](../../../../src/config/load-config.ts:103) 的 `mergeConfig`。
- 观察：`base`/`override`、`indexes` Map、同名命中走 `merged[index] = copy`、新名走 `push`。
- 要证明：同名 server 整替而非字段拼接；[load-config.test.ts](../../../../tests/config/load-config.test.ts) 的合并用例断言字段来自后层。
- 异常含义：`parseMcpServer` 对未知字段、非字符串 env 值、非数组 args 全抛 ConfigError，不让畸形对象进 transport。

### D2：transport 怎么选、env 在哪展开

- 断点：[client.ts](../../../../src/mcp/client.ts:105) 的 `#createTransport`，再进 [client.ts](../../../../src/mcp/client.ts:143) 的 `expandRecord` 与 [client.ts](../../../../src/mcp/client.ts:20) 的 `expandEnv`。
- 观察：`config.command` 决定 stdio；`config.url` + `config.transport==="sse"` 决定 SSE（惰性 import，[client.ts](../../../../src/mcp/client.ts:171)）；其余 url 走 StreamableHTTP。
- 正常值：`expandEnv("Bearer ${TOKEN}:$TOKEN:$MISSING",{TOKEN:"secret"})` → `Bearer secret:secret:`。
- 要证明：env/header 值被展开，但 command、args、server 名不被 expandEnv 触碰；[client.test.ts](../../../../tests/mcp/client.test.ts:6)。

### D3：握手与 content 聚合

- 断点：[client.ts](../../../../src/mcp/client.ts:41) 的 `connect`，[client.ts](../../../../src/mcp/client.ts:65) 的 `listTools`，[client.ts](../../../../src/mcp/client.ts:75) 的 `callTool`。
- 观察：`client.connect(transport)` 失败时 catch 里 `#client=null` + `transport.close()`；`callTool` 把 `content[]` 按 `type==="text"?text:serialize(block)` 用 `\n` 连接。
- 要证明：用 `tests/fixtures/mcp-stdio-server.mjs` 真起一个 stdio server，[client.test.ts](../../../../tests/mcp/client.test.ts:14) 断言 output 含两段 text 与一段 image JSON；断开后 listTools 抛 `is not connected`。

### D4：Manager 失败隔离

- 断点：[manager.ts](../../../../src/mcp/manager.ts:20) 的 `connectAll`，重点看 for 循环里的 try/catch（[manager.ts](../../../../src/mcp/manager.ts:31)）。
- 观察：`order`（连接顺序保持声明顺序）、失败分支 `client.disconnect()` + `errors.push`、成功分支 `#clients.set` + `tools.push`。
- 要证明：connect-fails / works / list-fails 三 server，[manager.test.ts](../../../../tests/mcp/manager.test.ts:26) 断言 works 的工具可用、两个失败 server 各自 disconnect、`getClient("works")` 返回成功 client。

### D5：wrapper 适配与异常转 ToolResult

- 断点：[tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:8) 构造、[tool-wrapper.ts](../../../../src/tools/tool-search.ts:33) 的 `schema`、[tool-wrapper.ts](../../../../src/mcp/tool-wrapper.ts:33) 的 `execute`。
- 观察：`name` 由 `toMcpToolName` 生成（`sanitizePart` 把 `.` `/` 替成 `_`）、`#remoteName` 保留远端原名、`execute` 捕获异常返回 `MCP tool error: <msg>`。
- 要证明：[tool-wrapper.test.ts](../../../../tests/mcp/tool-wrapper.test.ts:7) 断言 `mcp__git_hub_team__create_issue`、`callTool` 被以远端名 `create.issue` 调用；[tool-wrapper.test.ts](../../../../tests/mcp/tool-wrapper.test.ts:49) 断言异常→isError。

### D6：Registry deferred/discovered 与 ToolSearch 双语义

- 断点：[registry.ts](../../../../src/tools/registry.ts:22) 的 `listToolsForModel`、[registry.ts](../../../../src/tools/registry.ts:56) 的 `markDiscovered`、[tool-search.ts](../../../../src/tools/tool-search.ts:40) 的 `execute`。
- 观察：`listToolsForModel` 用 `!deferred || #discovered.has(name)`；关键词走 `searchDeferred` 不调 markDiscovered；`select:` 走 `selectTools` 调 markDiscovered 并返回 schema JSON。
- 要证明：[registry.test.ts](../../../../tests/tools/registry.test.ts:83) 验证注册后 schema 不含 deferred、markDiscovered 后含；[tool-search.test.ts](../../../../tests/tools/tool-search.test.ts:52) 验证关键词不激活、[tool-search.test.ts](../../../../tests/tools/tool-search.test.ts:69) 验证 select 激活、[tool-search.test.ts](../../../../tests/tools/tool-search.test.ts:87) 验证未命中不报错。

### D7（缺口）：Agent toolDefinitions 与 App 接线

- 断点：[agent.ts](../../../../src/agent/agent.ts:336) 确认已切到 `listToolsForModel()`（这是第 4 次开发真正落地的点）。
- 缺口观察：[app.tsx](../../../../src/tui/app.tsx:255) 仍每轮 `createToolRegistry()`，[app.tsx](../../../../src/tui/app.tsx:402) 的 `createToolRegistry` 只注册 6 个内置工具，**未注册 ToolSearch**；`AppProps`（[app.tsx](../../../../src/tui/app.tsx:36)）**不含** `mcpServers`/`mcpManagerFactory`。
- 现状证据：`npx tsc --noEmit` 在 [app.test.tsx](../../../../tests/tui/app.test.tsx:122) 与 [app.test.tsx](../../../../tests/tui/app.test.tsx:164) 各报一处 `Property 'mcpServers' does not exist on type 'IntrinsicAttributes & AppProps'`；这两个测试运行时超时失败。
- 结论：第 5、6 次（wrapper、tool-search）的协议层与第 4 次（Registry deferred、agent toolDefinitions）已落地且单测通过；第 7 次（App 生命周期、instructions、/mcp、/status）尚未接线，需补齐 AppProps、会话级 Registry/Manager ref、启动 connectAll 与卸载 disconnectAll、注册 ToolSearch、/mcp 与 /status 命令、instructions 注入 system reminder。

## 7. 故障注入实验

### 实验 1：同名 server 三层合并是否字段拼接

- 制造：用户层 `{name:github, command:cli, env:{TOKEN:"${TOKEN}"}}`，项目层 `{name:github, url:"http://x"}`。
- 观察：`mergeMcpServers` 命中同名 → 后层整替 → 结果是 `{name:github, url:"http://x"}`，command 丢失。
- 结论：server 是有身份的列表对象，按 name 整替；若需"命令来自项目层、凭据来自用户层"应放在同一层声明，否则字段拼接会造畸形对象。这是设计取舍，不是 bug。

### 实验 2：远端 callTool 抛错是否中断 Agent Loop

- 制造：用 [tool-wrapper.test.ts](../../../../tests/mcp/tool-wrapper.test.ts:49) 的 stub client（callTool 抛 `remote unavailable`），调 `wrapper.execute({},{workDir})`。
- 观察：返回 `{output:"MCP tool error: remote unavailable", isError:true}`，未抛异常。
- 结论：异常止步于 wrapper，作为结构化失败结果回灌，模型可据此换路径，与第五章 deny 回灌一致。

### 实验 3：Manager 一个 server 失败是否拖垮其他

- 制造：[manager.test.ts](../../../../tests/mcp/manager.test.ts:26) 的 connect-fails / works / list-fails 三 client。
- 观察：`result.servers=["works"]`、`result.errors` 含两个失败、`getClient("works")` 仍可用、两个失败 client 各调一次 disconnect。
- 结论：失败隔离生效，"部分成功"而非 Promise.all 全败。

### 实验 4：select 激活后是否真要等下一轮

- 制造：[agent.test.ts](../../../../tests/agent/agent.test.ts:27) 注册 `Deferred` 工具，第一轮用 hiddenProvider 断言 `requests[0].tools` 为 undefined；`markDiscovered("Deferred")` 后换 visibleProvider 再跑一轮。
- 观察：第二轮 `requests[0].tools.map(t=>t.name)` 才含 `["Deferred"]`。
- 结论：markDiscovered 改的是 Registry 状态，已发出的请求不可变，激活只影响下一轮 schema。

### 实验 5：ToolSearch 未命中是否报错

- 制造：[tool-search.test.ts](../../../../tests/tools/tool-search.test.ts:87) 调 `execute({query:"select:not-exist"},ctx)`。
- 观察：返回 `{output:"No deferred tools found matching: not-exist", isError:false}`。
- 结论：未命中不是错误，避免模型把"没找到"当成工具故障而误重试或中止。

### 实验 6：App 级 MCP 接线缺口

- 制造：运行 `npx tsc --noEmit` 与 `npx vitest run tests/tui/app.test.tsx`。
- 观察：typecheck 报 2 处 `mcpServers does not exist on AppProps`；两个 App MCP 测试超时失败（`Timed out waiting for App state`）。
- 结论：第 7 次开发（App 生命周期接线）尚未落地。协议层与 Registry 层单测不受影响（30 文件中其余 29 全绿）。补齐顺序建议：先扩 `AppProps` 加 `mcpServers`/`mcpManagerFactory` → 把 Registry 与 Manager 提升为会话级 ref → 启动 effect 调 `connectAll` 并注册 wrapper + ToolSearch → 卸载 effect 调 `disconnectAll` → 加 `/mcp`、`/status` 与 instructions reminder。

## 8. 当前局限

- **App 级接线未完成**：`App` 不接受 mcp 属性、`createToolRegistry` 未注册 ToolSearch、无 `/mcp` `/status`、无 instructions 注入、无会话级 Manager ref。导致 2 个集成测试失败、typecheck 报错；协议层与 Registry 层不受影响。
- **仅做 MCP tools**：不实现 resources、prompts、sampling、OAuth、自动重连、热加载。
- **无连接重试/健康检查**：connectAll 一次性顺序连接，运行中 server 崩溃不会自动恢复。
- **listTools 不跨轮缓存**：连接时列一次，运行期 server 工具变化不会被发现。
- **Bash 黑名单不保护 MCP 工具**：MCP 工具按 command 类依赖第五章规则与模式权限，第五章的 Bash 危险命令黑名单与路径沙箱不适用于远端副作用。
- **凭据边界依赖约定**：expandEnv 只对 env/header 值展开，但若用户把 token 直接明写进 YAML，client 不负责脱敏；日志与错误消息里未做 token 红action。
- **SSE 为兼容 fallback**：惰性加载，若 SDK 未导出 `SSEClientTransport` 会抛错。

## 9. 掌握标准

你能不看代码完成以下事情，就算掌握第 06 章：

- 画出配置→Manager→Client/Transport→Wrapper→Registry→ToolSearch→Agent权限执行的全链路，并标出四种状态各自的拥有者。
- 解释三层合并为什么按 name 整替而不是字段拼接，畸形对象会带来什么后果。
- 解释一个 server 失败为什么不阻断其他 server，Manager 返回的四类结果分别给谁用。
- 解释 registered 与 discovered 的区别，以及为什么 select 激活要等下一轮 schema。
- 解释 ToolSearch 关键词与 select 为什么必须分两种语义。
- 解释 MCP 工具为什么按 command 类走第五章权限链，且不需要新增 checker 分支。
- 解释 env/header 展开为什么只在连接边界，command/args/server 名为什么不展开。
- 诚实区分"已落地的协议层与 Registry 层"与"尚未接线的 App 生命周期"，并说出补齐顺序。
