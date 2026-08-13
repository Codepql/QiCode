# 第八章 Debug：持久化记忆与文件回滚

本章把 Agent 从“一次运行一次对话”扩展成可以恢复、记忆和回滚的工具。调试时不要先看 UI，先沿着数据流确认四件事：上下文从哪里来、消息写到哪里、记忆是否异步生成、文件与对话是否一起回退。

## 1. 一次完整调用链

- 启动：`injectDurableContext` 读取项目 instructions、已有 memory，并只向 `Conversation` 注入一次 system reminder。
- 普通轮次：用户消息由 `saveMessage` 写入 session JSONL；Agent 执行工具前由 `trackEdit` 备份文件；完成后由 `makeSnapshot` 建立回滚点。
- 轮次结束：`MemoryExtractor.extract` 在后台从对话中提取长期事实，成功后原子写入 memory 文件并重建索引。
- 恢复：`resumeSession` 读取最后一个 compact boundary 之后的消息，恢复会话 ID、文件历史和 durable context。
- 回滚：`handleRewind` 调用 `FileHistory.rewind` 恢复文件，再用 `Conversation.truncateTo` 删除对应消息之后的对话。

## 2. 关键函数定位

| 模块 | 函数 | 作用 |
| --- | --- | --- |
| instructions | `discoverInstructions` | 按项目目录向上查找指令文件 |
| instructions | `expandIncludes` | 展开 `@include`，限制深度、路径和循环 |
| memory | `parseFrontmatter` | 读取 memory 文件的类型、标题和更新时间 |
| memory | `rebuildIndex` | 把 memory 元数据写成轻量索引，避免每轮读取全文 |
| memory | `findRelevantMemories` | 先按 selector 选候选，再返回受控内容 |
| extractor | `MemoryExtractor.extract` | 向模型请求结构化记忆并进入保存流程 |
| extractor | `saveEntry` | 校验 slug、类型、长度后临时写入再原子替换 |
| session | `saveMessage` | 追加一条 JSONL 记录 |
| filehistory | `trackEdit` | 同一轮第一次修改某文件时保存原始状态 |
| filehistory | `rewind` | 恢复目标 snapshot 中的文件状态 |
| app | `resumeSession` | 切换 session 并恢复消息、上下文和文件历史 |
| app | `handleMemoryCommand` | 实现 `/memory` 状态查看和 selector 查询 |
| app | `handleRewind` | 实现 `/rewind` 列表、选择和回滚 |

## 3. 常见问题排查

### `/resume` 后上下文重复

检查 `Conversation.injectLongTermMemory` 是否只成功执行一次；恢复时应先从 boundary 之后重放消息，再注入 durable context。不要在每轮重新创建 Registry 或 Conversation。

### memory 文件没有生成

先看 `MemoryExtractor.isRunning` 和模型返回内容。提取器只接受固定 JSON 结构；返回 `NONE` 是合法的“没有值得长期保存的信息”，不是异常。写入失败时应保留原文件，不应留下半截 JSON。

### 同一轮改两次文件，回滚后仍不是最初状态

重点检查 `FileHistory.pendingBackups`。备份键必须按路径去重，并且只保存本轮第一次修改前的内容；`makeSnapshot` 后要清理 pending 状态。

### TUI 启动为空白

检查 `FileHistory` 初始化失败是否被捕获。历史目录不可写时，主对话仍应可以启动，只是 `/rewind` 不可用；这属于降级，不应让整个 App 崩溃。

### selector 查询结果异常

检查模型返回的 selector JSON 是否经过白名单校验。selector 只能映射到已建立索引的 memory 名称，不能直接变成文件路径或工具调用。

## 4. 安全边界

- `@include` 不能越过项目根目录，不能通过软链接逃逸，也不能无限递归。
- memory 提取内容必须经过 slug、类型、长度和文件名校验。
- memory 只是上下文提示，不是权限授予；真实工具仍然进入 PermissionChecker。
- session JSONL 逐行解析时跳过损坏的普通消息，但不能伪造边界或越权恢复文件。

## 5. 本次验收结果

本章最终验收实际执行：

```text
pnpm.cmd test       35 个测试文件，183 个测试通过
pnpm.cmd typecheck  通过
pnpm.cmd build      通过
git diff --check    通过
```

验收覆盖了损坏 JSONL、30 天过期清理、memory frontmatter/index、项目记忆提取、`NONE` 返回、重复编辑回滚、新文件删除回滚，以及现有 TUI 回归。
