# 07-Context 开发拆分

> 本文依据 `docs/plan/07-context/spec.md`、`plan.md`、`task.md`、`check.md` 与当前源码拆分。第七章开始前，只新增本章学习文档，不修改源代码、测试或已有规划。

## 当前真实起点

第六章结束后，QiCode 已有完整的 Agent 循环：`Conversation` 保存消息，`Agent` 每轮取出完整历史交给 `Provider.stream()`，工具结果再写回会话。问题是历史和工具输出会持续增长，长任务最终会触发模型上下文窗口上限。

第七章新增的是模型调用前的上下文调度层。它不能破坏真实会话历史，只能生成一份可以裁剪、落盘和压缩的 API 临时副本。

当前代码与原规划有三项已完成基础，不重复开发：

1. `ContextTooLongError` 已存在于 `src/llm/client.ts`。
2. `UsageInfo` 的 cache token 字段已存在于 `src/llm/events.ts`，且两个 Provider 已解析。
3. 当前会话类实际名为 `Conversation`，不是规划旧名称 `ConversationManager`。

还需要在接入阶段收口的一点：当前 `src/agent/agent.ts` 会先把每个工具输出截断为 10,000 字符。第七章应改由统一的 tool-result budget 决定何时保留、落盘或裁剪，否则大结果落盘不会真正触发。

## 拆分原则

本章同时有三类状态，不能混在一次开发中：工具输出替换状态、历史压缩状态、会话恢复边界。依赖关系如下：

```text
工具结果决策账本
        |
        v
落盘、预览与旧结果裁剪
        |
        +---------------------+
        |                     |
        v                     v
恢复状态                 压缩阈值与摘要逻辑
        |                     |
        +----------+----------+
                   v
          Agent 每轮调用前编排
                   |
                   v
  ContextTooLongError 紧急恢复 + /compact
                   |
                   v
          session 压缩边界持久化
```

建议拆成 7 次开发。每次只回答一个问题：谁拥有状态、什么时候改变状态、下一轮模型究竟看到什么。

## 第 1 次：工具结果决策账本与大输出落盘

对应原任务：T1-T5。

### 本次完成什么

- 新建 `src/toolresult/state.ts`，以 `toolUseId` 记录某条结果是否已经被替换及最终替换文本。
- 新建 `src/toolresult/budget.ts`，超大单条结果写入 `.qicode/tool_results/`，API 副本只保留固定预览、大小和路径。
- 同一结果在后续轮次始终使用同一个替换文本。
- 当一条工具结果消息的总量过大时，优先进一步裁剪较旧结果；最近结果保留更多内容。
- 将裁剪后的 `ConversationMessage[]` 重建为当前 Provider 可接收的会话输入。

### 阶段结果

```text
完整 tool_result
  -> ContentReplacementState 查账
  -> 首次超限：安全落盘 + 生成预览
  -> 后续使用：直接复用同一预览
  -> Provider 只接收临时副本
```

### 重点理解

落盘不是删除。完整结果仍在真实历史与工作区文件中；模型只看到足以定位和决定是否重新读取的摘要。账本的价值是稳定性：如果每轮预览都不同，Prompt Cache 前缀会不断失效。

## 第 2 次：可压缩会话与恢复附件

对应原任务：T6、T9-T11。

### 本次完成什么

- 给 `Conversation` 增加“摘要消息 + 最近原文”的替换方法。
- 新建 `src/compact/recovery.ts`，记录最近读取的文件和本轮使用的 Skill。
- 生成有明确预算的恢复附件：最近文件快照、活跃 Skill 摘要、可用工具名。

### 重点理解

摘要会丢失细节，因此不能只留摘要。恢复附件保留 Agent 刚刚依赖的工作现场；最近消息保留原文，避免模型继续执行时失去短期上下文。

## 第 3 次：压缩决策与摘要执行器

对应原任务：T12-T17。

### 本次完成什么

- 新建 `src/compact/compact.ts`。
- 使用字符数近似估算 token，并结合 `contextWindow`、输出预留和安全边距计算阈值。
- 低于阈值不调用摘要模型；超过阈值时只压缩较旧历史，保留最近消息以及完整 tool_use/tool_result 配对。
- 调用统一 `Provider` 生成结构化摘要，不向摘要请求传递工具 schema。
- 加入连续失败熔断，防止自动压缩失败后每轮无限调用模型。

### 阶段结果

```text
估算上下文
  -> 低于阈值：正常请求
  -> 超过阈值：旧历史 -> summary
  -> 会话变为：summary + 最近原文 + recovery attachment
```

### 重点理解

近似估算不是精确 tokenizer。它负责提前避险；Provider 返回的真实 usage 则作为锚点纠正后续增长估算。两者配合比为每个 Provider 引入不同 tokenizer 更符合当前统一 Provider 架构。

## 第 4 次：压缩边界的 session 持久化

对应原任务：T18-T19。

### 本次完成什么

- 新建 `src/session/session.ts`。
- 保存 `compact_boundary`：摘要内容、保留消息定位和创建时间。
- 重建 session 时识别有无压缩边界的两条路径。

### 重点理解

本章写边界，不完成完整 `/resume` 体验。第八章可以把边界作为稳定输入恢复会话，避免重新猜测摘要覆盖了哪一段历史。

## 第 5 次：Agent 主循环接入与紧急恢复

对应原任务：T20-T24。

### 本次完成什么

- 每次 `Provider.stream()` 前先构造 API 临时副本，执行 `applyBudget` 和 `manageContext`。
- 维护 usage anchor，避免把已由 Provider 计量过的历史在每轮重复累加。
- 读取文件成功后记录到 `RecoveryState`。
- 收到 `ContextTooLongError` 时，至多强制压缩一次并重试当前请求一次；第二次仍失败则停止并回报。
- 增加结构化 compact 事件，供 TUI 展示。

### 重点理解

自动压缩是预防；`ContextTooLongError` 恢复是兜底。二者不能互相替代，因为字符估算有误差，Provider 的实际窗口也可能因模型或工具 schema 改变。

## 第 6 次：/compact 命令与 TUI 接线

对应原任务：T25-T27。

### 本次完成什么

- 新建命令注册表，注册 `/compact` 和 `/c`。
- TUI 空闲时调用 `forceCompact`，展示压缩前后消息数量、摘要长度和保留原文数量。
- 写入 compact boundary。
- 创建 Agent 时按 Provider 协议传入 `contextWindow` 与 `maxOutput`。

### 重点理解

手动压缩是用户的意图信号，因此可以绕过自动压缩的冷却或阈值；但流式请求进行中不能与它并发修改同一份会话。

## 第 7 次：章节验收与学习交付

对应原任务：T28-T33。

### 验收主线

1. 60KB 工具输出落盘，模型历史只包含稳定预览，原始会话不被破坏。
2. 多条结果超预算时，旧结果先裁剪，最近结果保留更多信息。
3. 自动压缩只在阈值后发生，摘要请求不携带工具 schema。
4. `/compact` 能生成摘要并写入边界。
5. `ContextTooLongError` 最多触发一次紧急压缩与一次重试。
6. 恢复附件遵守独立预算，不反过来撑爆上下文。

本阶段才集中运行用户允许的测试、类型检查、构建和手动长任务验证，并以实际结果更新 Debug、Understanding、Interview 文档。

## 原任务覆盖关系

| 开发次数 | 覆盖原任务 |
| --- | --- |
| 第 1 次 | T1-T5 |
| 第 2 次 | T6、T9-T11 |
| 第 3 次 | T12-T17 |
| 第 4 次 | T18-T19 |
| 第 5 次 | T20-T24 |
| 第 6 次 | T25-T27 |
| 第 7 次 | T28-T33、学习文档 |

## 每次开发后的学习动作

1. 画出这次新增状态的拥有者：Agent、Conversation、toolresult、compact 或 session。
2. 区分完整历史和 API 临时副本，说明哪个会被修改、哪个不会。
3. 找到一次状态写入和下一轮读取的位置。
4. 解释一个故障场景：落盘失败、摘要失败或 Provider 仍然超长时，Agent 为什么不会无限重试。
