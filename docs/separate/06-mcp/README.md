# 06-MCP 开发拆分

> 本文依据 `docs/plan/06-mcp/spec.md`、`plan.md`、`task.md`、`check.md` 和当前源码拆分。这里只新增本章文档，不修改既有规划文件。

## 当前真实起点

第五章完成后，QiCode 的工具执行边界已经稳定：`ToolRegistry` 保存工具，`Agent` 在 `executor.submit()` 前经过 `PermissionChecker`，工具本身只需要实现统一 `Tool` 接口。

第 06 章要把“写死的内置工具”扩展成“配置驱动的外部工具生态”。MCP 协议层负责连接和调用，Agent 不应该知道某个工具来自本地还是远端。

当前代码与旧规划存在以下差异：

1. 配置真实文件是 `src/config/types.ts` 与 `src/config/load-config.ts`；不存在规划中的 `src/config/config.ts`。
2. 当前 `loadConfig()` 接收一个明确路径，且只解析 `providers`；三层配置合并需要在现有加载器上增量扩展。
3. 当前 `ToolRegistry.getAllSchemas()` 尚未支持 deferred 工具；`Agent` 也在 `agent.ts` 内自行生成工具定义，因此延迟加载必须同时修改 Registry 和 Agent 的真实 schema 路径。
4. 当前 `App.submit()` 每轮创建 `ToolRegistry`，MCP Manager、已激活工具和连接会话必须提升到会话级 ref，不能每轮丢失。
5. 当前项目使用 `.QiCode/` 配置目录，规划中的 `.qicode/` 需要统一或做平台无关的规范化处理。

## 拆分原则

MCP 的难点不是“调用一个 SDK 方法”，而是四种状态同时存在：配置状态、连接状态、工具发现状态、工具激活状态。按以下依赖拆分：

```text
配置模型与合并
        |
        v
官方 SDK transport + 单 server 会话
        |
        v
多 server 管理与失败隔离
        |
        +----> deferred Registry
        |             |
        |             v
        |       ToolSearch 激活
        |             |
        v             v
      MCPToolWrapper + 权限自然接入
              |
              v
      App/Main 生命周期与状态指令
              |
              v
      端到端冒烟 + 学习文档
```

建议拆成 8 次开发。每次只引入一个新的状态转移，先能解释“谁拥有它、谁改变它、下一轮如何看到它”。

## 第 1 次：MCP 配置类型与三层合并

对应原任务：T2。

### 本次完成什么

- 在 `src/config/types.ts` 增加 `MCPServerConfig` 和 `AppConfig.mcp_servers`，缺省为空数组。
- 在 `src/config/load-config.ts` 扩展 YAML 根字段校验、MCP server 字段校验和环境变量语义。
- 保持显式 `--config` 的旧行为；只有未指定路径时才启用用户级、项目级、本地覆盖三层读取。
- 同名 server 使用后层完整替换，新增 server 保持声明顺序追加。
- 明确命令、参数、server 名和工具名不展开环境变量；只在连接阶段展开 env/header 值。

### 重点理解

配置合并不是普通深合并。server 是有身份的列表对象，按 `name` 做替换；字段级拼接可能生成一个命令来自项目层、凭据来自用户层的畸形对象。

## 第 2 次：官方 SDK 与单 server MCPClient

对应原任务：T1、T4。

### 本次完成什么

- 增加 `@modelcontextprotocol/sdk` 依赖，确认当前安装版本的真实导出路径。
- 新建 `src/mcp/client.ts`，只封装一个 server 的生命周期。
- 支持 stdio、Streamable HTTP、SSE 三种 transport。
- 实现初始化握手、列工具、调用工具、读取 instructions、断开连接。
- 将远端 content block 聚合为统一字符串；调用异常转为上层可捕获的错误。

### 阶段结果

```text
MCPServerConfig
  -> transport
  -> Client.connect()
  -> listTools()
  -> callTool(name, args)
```

协议消息编解码、request/response 配对和 transport 细节全部交给官方 SDK，不在项目内自研 JSON-RPC。

## 第 3 次：MCPManager 与失败隔离

对应原任务：T5。

### 本次完成什么

- 新建 `src/mcp/manager.ts`，维护 `Map<serverName, MCPClient>`。
- 顺序连接 server，单个 server 的连接失败、列工具失败不影响后续 server。
- 返回成功 server、发现工具、instructions 和错误四类结果。
- 提供 `getClient()` 与 `disconnectAll()`。
- 设计连接状态的最小可观察结构，避免 App 直接理解 SDK 异常。

### 重点理解

失败隔离不是吞掉错误。错误必须被收集并展示，同时成功 server 仍然可用。Manager 是“部分成功”的编排层，不是简单的 `Promise.all()` 全成全败。

## 第 4 次：Tool 接口与 Registry 的 deferred 能力

对应原任务：T3。

### 本次完成什么

- 给 `Tool` 增加 `deferred?`、`system?` 元数据。
- Registry 增加 discovered 集合和查询 API。
- 未激活的 deferred 工具不进入模型 schema；已激活工具在后续轮次持续可见。
- 保持 Anthropic/OpenAI 两种 schema 转换的一致性。
- 修改 `src/agent/agent.ts` 的真实 `toolDefinitions()` 路径，使其使用 Registry 的 deferred 规则；不能只改未被调用的 `getAllSchemas()`。

### 阶段结果

```text
注册工具 != 立即暴露给模型
注册工具 -> deferred 未激活 -> 隐藏
ToolSearch select -> markDiscovered
下一轮 schema -> 出现已激活工具
```

## 第 5 次：MCPToolWrapper 与权限边界

对应原任务：T6、F14。

### 本次完成什么

- 新建 `src/mcp/tool-wrapper.ts`。
- 将远端工具包装为 `Tool`，统一命名为 `mcp__<server>__<tool>`。
- server/tool 名中的非法字符替换为 `_`，保留来源可追溯性。
- category 固定为 `command`，默认走 Ask；schema 原样透传。
- 远端调用异常转换为 `ToolResult { isError: true }`，不抛出到 Agent Loop。
- 不修改 `src/permissions/checker.ts`：既有规则引擎通过完整 MCP 工具名自然匹配。

### 重点理解

这是适配器，不是第二套工具系统。Agent 只看到 `Tool`，权限系统只看到一个命令类工具；MCP 协议细节止步于 wrapper 之前。

## 第 6 次：ToolSearch 与按需激活

对应原任务：T7、F9。

### 本次完成什么

- 新建 `src/tools/tool-search.ts`，作为 `system: true` 的只读内置工具。
- 普通查询只返回名称和简短描述，不激活工具。
- `select:<name>` 精确激活 deferred 工具并返回 schema。
- 设置合理的返回上限，查询为空或找不到工具时返回结构化结果。
- 确保 ToolSearch 自身始终可见，否则模型无法发现隐藏工具。

### 阶段结果

```text
模型不知道工具名
  -> ToolSearch(query="github issue")
  -> 得到候选名
  -> ToolSearch(query="select:mcp__github__create_issue")
  -> 下一轮模型看到 schema
```

延迟加载解决的是上下文规模和工具选择噪声，不是权限控制；激活后仍然经过第五章权限链。

## 第 7 次：App/Main 生命周期、instructions 与状态指令

对应原任务：T8、T9、F10-F12。

### 本次完成什么

- `main.tsx` 把 `cfg.mcp_servers` 透传给 App。
- App 启动后异步连接 MCP，不阻塞进入会话界面。
- Registry、MCPManager、激活集合在会话内保持稳定；组件卸载时断开所有连接。
- 成功连接后注册 wrapper，注入 server instructions 系统提醒。
- 增加 `/mcp` 和 `/status` 的 MCP 概览。
- 连接失败以系统消息展示，不污染 provider 错误处理，也不让失败 server 阻断内置工具。

### 需要特别检查

App 当前 runtime 和 registry 的生命周期是按轮设计的；本次必须把 Registry 提升到会话级，否则每轮会丢失 MCP wrapper 和 discovered 状态。

## 第 8 次：端到端验收与学习交付

对应原任务：T10、T11、Debug、Interview。

### 验收主线

1. 无 MCP 配置时，原有会话正常启动。
2. 一个可用 stdio server 能握手、列工具、检索并调用 echo 类工具。
3. 一个失败 server 不影响另一个成功 server。
4. deferred 工具默认不进 schema，select 后下一轮出现。
5. MCP 工具默认按 command 类触发权限确认，规则和 bypass 行为符合第五章。
6. Anthropic/OpenAI 工具 schema 都正确，MCP wrapper 不引用具体 Provider。
7. 退出 App 时 server 子进程和连接被释放。

本阶段才运行用户允许的测试和手工 MCP server 冒烟。当前任务阶段不跑 `*.test.*`，只做静态阅读和实现准备。

## 原任务覆盖关系

| 开发次数 | 覆盖原任务 |
| --- | --- |
| 第 1 次 | T2 |
| 第 2 次 | T1、T4 |
| 第 3 次 | T5、F11 |
| 第 4 次 | T3、F9 的 Registry 部分 |
| 第 5 次 | T6、F7、F8、F14 |
| 第 6 次 | T7、F9 |
| 第 7 次 | T8、T9、F10-F12 |
| 第 8 次 | T10、T11、学习文档 |

## 每次开发后的学习动作

1. 画出本次新增状态：配置、连接、发现、激活或执行结果。
2. 解释一个真实对象的所有者：谁创建、谁持有、谁释放。
3. 观察一次工具 schema 在“注册、隐藏、激活、发送”四个时刻的变化。
4. 说明失败发生在哪一层，以及为什么不应该扩散到其他 server。
