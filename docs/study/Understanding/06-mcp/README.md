# 06-MCP 开发前认识与理解

> 本文用于第 06 章开发前学习。目标不是背 MCP API，而是理解外部工具如何进入 Agent 的统一执行边界。

## 一、为什么需要 MCP

第五章之后，QiCode 已经能安全地调用一组内置工具，但这些工具都写死在 `createToolRegistry()` 中。想接 GitHub、数据库或内部服务，若每次都新增一套 TypeScript 工具，就会把 Agent 核心和外部服务强耦合。

MCP 的价值是把两件事分开：

```text
工具提供方（MCP server）
        |
        | 标准协议
        v
QiCode MCP client -> 统一 Tool -> Agent
```

QiCode 不需要知道“GitHub 工具的 HTTP 细节”，只需要知道它实现了 `Tool`，有名称、描述、schema 和 `execute()`。

## 二、本章要完成的能力

本章最终形成四条链路：

```text
配置链：YAML -> MCPServerConfig -> transport
连接链：connect -> initialize -> listTools
工具链：MCPTool -> wrapper -> ToolRegistry -> Agent
发现链：ToolSearch -> markDiscovered -> 下一轮 schema
```

用户看到的是：启动时外部 server 自动连接；失败 server 不影响会话；模型可以搜索并激活工具；激活后的工具像内置工具一样调用，并继续经过第五章权限护栏。

本章不实现 MCP resources、prompts、sampling、OAuth、自动重连或热加载。

## 三、当前代码与规划的真实差距

当前源码已经有：

- `Tool` 接口和 `ToolRegistry`；
- `Agent` 每轮从 Registry 生成工具定义；
- `App` 每轮创建工具 Registry；
- `src/config/types.ts` 与 `src/config/load-config.ts` 解析 provider 配置；
- `PermissionChecker` 按工具类别做最终执行前判断。

还没有：

- `src/mcp/` 目录和 SDK 依赖；
- MCP server 配置字段和三层合并；
- 单 server 会话和多 server 管理器；
- deferred/discovered 工具状态；
- ToolSearch；
- MCP 生命周期的 App 接线。

因此第 06 章的第一件事不是写 MCP client，而是先解决“外部工具怎样被当前架构承载”。

## 四、一次完整调用流程

```text
1. loadConfig 读取 mcp_servers
2. App 会话启动，MCPManager 逐个连接 server
3. MCPClient 完成 initialize 和 listTools
4. 每个远端工具包装为 mcp__server__tool
5. wrapper 注册到会话级 ToolRegistry，但标记 deferred
6. Agent 第一轮只暴露内置工具、ToolSearch 和已激活 MCP 工具
7. 模型调用 ToolSearch 搜索关键词
8. ToolSearch select 精确激活目标工具
9. 下一轮工具 schema 出现在 Provider 请求中
10. 模型发起 MCP tool_use
11. Agent 调 PermissionChecker：MCP 工具按 command 类处理
12. 用户批准后 wrapper 调 MCPClient.callTool
13. 远端结果聚合成 ToolResult，回灌 Conversation
```

关键的时间点是第 8 到第 9 步：激活不是立即改变已经发出的请求，而是影响下一轮 schema。

## 五、MCP 的三层对象模型

### 1. MCPClient：一个 server 的协议会话

它拥有 transport 和官方 SDK `Client`，负责：

- 建立连接和初始化握手；
- 列出工具；
- 调用原始工具名；
- 获取 instructions；
- 关闭连接。

它不应该注册 Tool，也不应该决定权限。

### 2. MCPManager：多个 server 的生命周期

Manager 维护 `Map<serverName, MCPClient>`，负责批量连接、失败收集和统一断开。它的核心语义是“部分成功”：一个 server 失败时，其他 server 仍然可以被使用。

### 3. MCPToolWrapper：协议适配器

Wrapper 把远端的：

```text
{ name, description, inputSchema }
```

转换成项目的：

```text
Tool { name, description, category, schema(), execute() }
```

Wrapper 的 `execute()` 只负责调用对应 server 和把异常转成 `ToolResult`，不把 MCP 错误抛到 Agent Loop。

## 六、为什么必须有命名空间

远端 server 都可能提供 `search`、`list`、`create`。最终名称统一为：

```text
mcp__github__search
mcp__sqlite__search
```

命名空间同时解决：

1. 工具冲突；
2. 来源追踪；
3. 权限规则定位。

`mcp__github__*` 可以直接成为第五章规则的匹配对象。MCP 层不需要修改权限代码，因为权限系统只依赖统一工具名和类别。

## 七、为什么要延迟加载

如果连接 10 个 server、每个返回 50 个工具，直接把 500 份 schema 放进 system/tool 请求，会带来：

- 上下文和请求成本增加；
- 模型选择工具时噪声变大；
- Provider 缓存前缀更容易变化；
- 用户很难知道模型为什么选择某个工具。

所以 Registry 需要区分两个状态：

```text
registered  已连接并可调用
discovered  已激活并暴露给模型
```

未激活的 MCP 工具仍然存在于 Registry，只是不进入 schema。ToolSearch 是唯一的发现入口。

## 八、ToolSearch 的两种语义

### 关键词搜索

```text
query = "github issue"
```

只返回候选名和短描述，不改变状态。这是探索行为。

### 精确激活

```text
query = "select:mcp__github__create_issue"
```

按完整名称查找、标记 discovered，并返回 schema。下一轮 Agent 重新生成工具定义后，模型才真正拥有调用入口。

这两个动作必须分开，否则模型一次模糊搜索就可能把大量工具全部暴露出来。

## 九、配置和凭据的边界

配置层负责声明 server，不负责连接。连接层才展开：

```yaml
mcp_servers:
  - name: github
    command: github-mcp
    env:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
```

展开只作用于 env/header 的值：

- server 名和工具名不展开；
- command 和 args 不展开；
- 未定义变量变成空字符串；
- 原始配置对象不被修改；
- 日志和错误不能打印 token。

这样做的重点不是“隐藏字符串”，而是保证凭据只在连接边界进入 transport，不会被写回 YAML。

## 十、失败隔离为什么不能用全局 Promise.all

MCP server 是外部依赖，可能不存在、启动失败、协议不兼容或列工具失败。若使用全局 `Promise.all()`，一个 server reject 就会让整个启动失败。

Manager 应该返回：

```ts
{
  servers: ["github"],
  tools: [...],
  instructions: [...],
  errors: [{ serverName: "sqlite", error: "..." }]
}
```

成功结果继续注册，错误结果交给 TUI 展示。失败隔离不是静默忽略，而是把失败限制在它所属的 server。

## 十一、MCP 与权限系统的关系

MCP 工具统一分类为 `command`，因此默认模式下 Ask，acceptEdits 仍 Ask，bypass 模式下 Allow；显式规则可以按完整工具名匹配。

权限层不需要知道 transport 是 stdio 还是 HTTP，也不需要解析远端参数中的文件路径。这个取舍很保守：远端工具可能对数据库、网络或第三方 API 产生副作用，默认按命令类处理更容易解释。

安全边界仍在 Agent：

```text
MCPToolWrapper.execute()
必须在
PermissionChecker -> onPermissionRequest -> executor.submit()
之后才发生
```

## 十二、会话级状态为什么重要

MCP 连接、Registry、discovered 集合和 Agent Conversation 必须属于同一个会话。

如果每轮重新创建 Registry，会出现：

- 已激活工具下一轮消失；
- wrapper 丢失；
- Manager 仍持有连接但没有工具引用；
- instructions 重复注入或无法追踪。

所以第 07 次接线时要把 Registry 和 Manager 放进 App 的 ref/state 生命周期，并在卸载时 disconnectAll。

## 十三、开发前建议掌握的 12 个问题

1. MCP 解决的是工具协议、工具发现还是权限问题？
2. 为什么必须用官方 SDK，而不是自己写 JSON-RPC？
3. `MCPClient`、`MCPManager`、`MCPToolWrapper` 各自拥有什么状态？
4. 为什么一个 server 失败不能阻止其他 server？
5. 为什么 server/tool 名需要命名空间？
6. registered 和 discovered 有什么区别？
7. 为什么关键词搜索不能直接激活工具？
8. 为什么 select 激活后要等下一轮 schema？
9. 为什么 App 不能每轮新建 Registry？
10. MCP 工具为什么按 command 类进入第五章权限链？
11. 环境变量展开为什么只能发生在连接阶段？
12. MCP instructions 为什么进入 reminder，而不是修改固定 system prompt？

## 十四、面试表达

### 30 秒版本

> 我给 Agent 增加了 MCP client，把配置中的外部 server 通过官方 SDK 连接起来，经过 initialize/listTools 后包装成统一 Tool。远端工具用 `mcp__server__tool` 命名并默认 deferred，通过 ToolSearch 按需激活，避免把大量 schema 一次性塞进上下文。调用时仍走原有 PermissionChecker，所以 Agent 和 Provider 都不需要知道工具来自哪里。

### 深挖时的诚实边界

- 本章只做 MCP tools，不做 resources、OAuth、自动重连和热加载。
- Bash 的命令黑名单不会自动保护 MCP 工具；MCP 工具依赖规则和模式权限。
- 远程 server 的网络可靠性和服务端安全不由 client 完全解决。
- 延迟加载减少上下文噪声，但不能替代权限校验。

## 通过标准

你能不看代码画出：

```text
配置 -> Manager -> Client/Transport -> Wrapper -> Registry
                                           |
                                           v
                                    ToolSearch 激活
                                           |
                                           v
                                    Agent 权限执行
```

并且能解释：工具为什么先注册后隐藏、为什么激活要等下一轮、为什么 server 失败不影响其他 server、为什么 MCP 仍然必须经过第五章权限护栏。
