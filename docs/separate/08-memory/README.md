# 08-Memory 开发拆分

> 本文依据 `docs/plan/08-memory/` 与第七章最终代码拆分。第八章开始前，只新增本章规划与 Start 文档，不创建源代码或测试。

## 当前真实起点

第七章已经提供了下面这些基础：

```text
src/session/session.ts
  - JSONL 的 saveMessage / loadSession
  - compact_boundary 的 saveCompactBoundary
  - rebuildFromSession：按最后一个 boundary 重建消息

src/tui/app.tsx
  - 每次启动生成一个临时 sessionId
  - /compact 和自动压缩会写 compact_boundary
```

但目前还有明显缺口：

1. 用户消息和助手最终回复没有实时写入 JSONL，因此 session 文件通常只有压缩边界。
2. sessionId 的生成在 `App` 内部，格式不是第八章统一的“时间戳 + 随机后缀”。
3. 没有 `listSessions()`、`cleanExpiredSessions()`、`/resume`。
4. 没有 `src/memory/`；项目指令和长期笔记都不存在。
5. 原规划中的 `src/commands/commands.ts`、`FileHistory`、`rewind-dialog.tsx` 当前不存在，不能照文件名直接开发，必须在实现前重新确认第九章命令系统的边界。

## 拆分原则

第八章有四条独立链，不能混成一次大改动：

```text
项目指令加载 -----------+
                         -> 启动时一次性注入 Conversation
长期记忆索引 -----------+

会话 JSONL 完整写入 -> 列表 -> /resume -> 恢复后继续追加

Agent 自然结束 -> 后台笔记提取 -> 双目录写入 -> 重建索引

文件编辑快照 -> /rewind              （独立，最后做）
```

建议拆成 8 次开发。每次完成一个用户可解释的能力，而不是先堆所有存储层。

## 第 1 次：补全 session 基础能力

对应原任务：T1、T2 的未完成部分。

### 本次完成什么

- 将 `newSessionId()` 从 `App` 提取到 `src/session/session.ts`，统一生成可排序、可校验的 ID。
- 为 session 模块增加 `listSessions()`：消息数、首条用户消息标题、文件大小、最后修改时间。
- 增加 `cleanExpiredSessions()`：按文件 mtime 清理过期 JSONL，单文件失败不影响其他文件。
- 校正现有 `rebuildFromSession()` 与第七章的完整 message block 结构一致。

### 重点理解

JSONL 解决“怎么保存”；`listSessions()` 解决“用户怎么找到旧会话”；`rebuildFromSession()` 解决“压缩过的历史怎么正确继续”。这是三个不同问题。

## 第 2 次：会话实时落盘

对应原任务：T11 的会话部分。

### 本次完成什么

- `App.submit()` 收到普通用户输入后，追加一条 user JSONL 记录。
- Agent 正常结束并产生最终文本后，追加一条 assistant JSONL 记录。
- 继续复用第七章已有的 compact boundary 写入。
- 存档写失败只显示诊断或忽略，不能中断正常对话。

### 阶段结果

```text
用户输入 -> Conversation + JSONL user line
Agent 完成 -> Conversation + JSONL assistant line
压缩发生 -> JSONL compact_boundary line
```

## 第 3 次：`/resume` 列表与恢复

对应原任务：T10、T13，但命令接入方式以当前 `App.submit()` 为准。

### 本次完成什么

- `/resume`：列出最近会话和简短标题。
- `/resume <id>`：加载 JSONL，使用 `rebuildFromSession()` 重建 Conversation。
- 恢复后替换 `sessionIdRef.current`，后续消息继续写到同一个文件。
- 保留当前项目指令/记忆注入能力的插槽，恢复时不能重复注入。

### 重点理解

恢复不是把所有 JSONL 行无脑读回去。若存在 `compact_boundary`，边界之前的历史已经被摘要覆盖，重放它们会让上下文重新膨胀。

## 第 4 次：项目指令加载器

对应原任务：T3。

### 本次完成什么

- 新建 `src/memory/instructions.ts`。
- 按用户全局、仓库到工作目录的层级发现指令文件。
- 支持受限的 `@include`，含相对路径、用户目录和绝对路径。
- 做项目根边界、循环检测、深度上限和代码块跳过。

### 重点理解

项目指令是用户明确写下的规则，不是模型自动抽取的偏好。它要在第一轮前进入上下文，因此不能等待 Agent 循环开始后再添加。

## 第 5 次：记忆索引与启动注入

对应原任务：T4、T8 的启动部分。

### 本次完成什么

- 新建 `src/memory/manager.ts`。
- 扫描项目级与用户级 Markdown 记忆，解析 frontmatter，生成有长度上限的索引摘要。
- 启动时把“项目指令 + 记忆索引”一次性注入 Conversation 的第一条系统提醒。
- 保证同一个 Conversation 实例最多注入一次；恢复新 Conversation 时重新注入。

### 阶段结果

```text
新 Conversation
  -> loadInstructions()
  -> MemoryManager.buildSystemReminder()
  -> addSystemReminder()
  -> 第一轮模型已知道项目规则和记忆索引
```

## 第 6 次：后台 MemoryExtractor

对应原任务：T5、T9、T12。

### 本次完成什么

- 新建 `src/memory/extractor.ts`。
- Agent 自然结束后触发，不阻塞用户下一轮输入。
- 从最近会话抽取稳定偏好、纠正反馈、项目知识、参考资料。
- 按类型写入用户级或项目级目录，使用安全文件名和原子写入。
- 多次触发合并成一次尾部运行，避免同一段会话被连续提取。
- 成功写入后重建索引；失败只留诊断，不影响主对话。

### 重点理解

自动记忆是后台副作用，不能放进 Agent 主循环的关键路径。否则“记一条偏好失败”会阻塞正常编码对话。

## 第 7 次：按需记忆查询与状态命令

对应原任务：F34、F35，以及 `/memory` 的当前项目适配。

### 本次完成什么

- 先实现 `/memory`：显示项目/用户记忆目录、索引摘要、最近笔记。
- 再实现 `MemoryManager.findRelevantMemories(query)` 的选择器：模型只在需要时从候选元数据中挑少量相关笔记。
- 保持“背景索引”和“按需全文选择”分开，避免启动时注入全部 Markdown 正文。

## 第 8 次：文件快照、`/rewind` 与章节验收

对应原任务：T6、T14-T16、学习交付。

### 本次完成什么

- 重新确认文件编辑工具的真实接入点，再新建 file history 模块。
- 写入前保存有限版本快照，`/rewind` 以确认交互恢复。
- 后台清理过期 session。
- 最后补全 session、memory、resume、rewind 的测试与真实终端冒烟。
- 生成本章 Debug 与 Interview 文档，并以实际测试数字为准。

## 建议实施顺序

```text
第 1 次 session 基础
  -> 第 2 次实时落盘
      -> 第 3 次 /resume

第 4 次指令加载
  -> 第 5 次记忆索引与启动注入
      -> 第 6 次后台提取
          -> 第 7 次按需查询

第 8 次文件回退 + 章节验收
```

会话恢复链与指令/记忆链可以分别开发，但第 3 次恢复时必须预留第 5 次的“新 Conversation 再注入一次”入口。

## 每次开发后的学习动作

1. 说清楚保存的是“完整消息、摘要边界还是长期笔记”。
2. 找到真正触发写盘的函数，区分同步主链和后台副作用。
3. 说明进程崩溃、坏 JSON 行或笔记提取失败时，用户会看到什么。
4. 解释恢复时为什么只使用最后一个 `compact_boundary`。
