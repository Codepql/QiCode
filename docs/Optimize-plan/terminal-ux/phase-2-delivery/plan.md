# 第二期技术方案

状态：方案草案；配合 [spec.md](spec.md)，不代表新增接口已实现。

## 1. 路线选择

推荐保留现有 Agent/Provider/工具，在短链路内补齐证据、执行和恢复。单改提示词可用于最初行为验证，但不能修正断流、全局超时、日志丢失；整体换成 pi 运行时会扩大协议、权限和会话迁移面。本期不替换整体架构。

目标链路：用户请求 → 共享运行层 → Agent Loop → 已校验工具 → 磁盘/命令 → 验证证据回灌 → 有限修复 → 交付或明确停止。

## 2. 模块边界

| 边界 | 复用模块 | 必要改动 |
| --- | --- | --- |
| 行为与真实环境 | `src/prompt/sections.ts`、`builder.ts`、`src/memory/instructions.ts` | 持续执行、验证、阻塞处理；实际 Shell 与目录约束注入 |
| 协议 | `src/llm/openai.ts`、`anthropic.ts`、`events.ts` | 正常终止判定、stopReason 保真、参数解析错误；不执行截断工具 |
| 执行入口 | `src/agent/streaming-executor.ts`、`src/tools/types.ts` | schema 校验、结构化工具结果、开始/更新/结束事件、取消 |
| 编排 | `src/agent/agent.ts` | 任务预算、有限重试、失败签名、steering 边界与完成证据 |
| Shell | `src/tools/bash.ts`、环境检测 | 同一 Shell 配置驱动描述和 spawn；增量日志、退出状态、进程树清理 |
| 精准修改 | `src/tools/edit-file.ts`、`src/fs/file-access.ts` | 格式兼容、有界 diff、冲突错误与已有锁/版本机制组合 |
| 工作现场 | `src/session/session.ts`、`src/filehistory/filehistory.ts` | 版本化结构消息、intent/outcome、任务与验证记录、旧格式读取 |
| 上下文 | `src/compact/*`、`src/toolresult/*` | 能力预算、取消、任务事实保留、复用现有溢出结果存储 |
| 界面适配 | `src/tui/app.tsx`、`tool-display.tsx`、`chat-view.tsx` | 从统一事件消费进度；移出会话生命周期关键逻辑 |

共享运行层只负责主任务生命周期、事件持久化、预算与继续入口；不要顺便重写 Skills、Team 或 Hook 系统。可先从 app.tsx 提取主执行路径，保留现有测试注入点，逐步接管而非一次拆散整个文件。

## 3. 最小数据契约

- 工具结果保留现有 `output/isError`，增量增加可选 metadata：退出码、状态、耗时、cwd、日志引用、truncated、变更摘要。工具适配器逐步接入，不能破坏 MCP 现有回灌。
- AgentEvent 区分“模型请求工具”“工具真实开始”“工具更新”“工具结束”，不要在尚未审批时显示已执行。
- TaskRun 只保存 ID、目标/约束、状态、预算、调用与证据引用、待做事项。不引入独立规划 Agent 或强制模型输出 JSON 计划。
- VerificationRecord 保存命令、cwd、开始/完成时间、exitCode、状态、日志引用和关联变更版本；新修改后旧验证不再被当作最新版本通过。
- 完成状态不得仅由文本匹配驱动。模型的交付陈述与运行层观察证据分开保存；未识别出合适检查时标未验证，不强装框架。

## 4. 工具与验证边界

验证仍通过现有命令工具执行，使用项目已有入口。任务开始先观察相关初始检查状态和工作区差异；昂贵全量检查可按范围跳过，但必须记录未覆盖部分。

模型负责选择、定位和修复；运行层负责记录实际命令结果、限制次数、保留日志。运行层不尝试用简单文本规则证明业务正确，也不自动在每次写入后跑全部测试。

参数校验、权限和执行共用一条入口：调用完整性检查 → schema 校验 → 现有 Hook/权限 → 取消检查 → intent 落盘 → 执行 → outcome 与结果回灌。中断后未执行的调用要有配对的未执行结果，不能污染下一轮协议。

默认编辑保持精确匹配；格式归一化仅用于匹配，输出保留原文件换行/BOM。多个文件不声称具有跨文件原子事务，失败时列出已生效修改。

## 5. 预算与恢复

运行配置使用独立应用级区，建议 `execution`，不塞入 Provider 的六字段。字段包括 taskTimeoutMs、maxIterations、requestIdleTimeoutMs、commandTimeoutSeconds、maxCommandTimeoutSeconds、maxRepairRounds、maxProviderRetries、toolOutputDiskLimitBytes。实现时定义默认值和层级覆盖，以字段替换覆盖，不通用深合并。

初始默认值遵循 spec；日志磁盘配额建议每任务 100 MiB。UI 显示尾部预览，模型回灌有界，磁盘内容不能因字符预算被无痕删除。访问内部日志经受控引用映射，不为读取结果而放开任意工作区外路径。

有界重试只重复失败的 Provider 请求或确认未执行的调用。已经落盘的工具结果复用；断线前完成写入、断线后未收到模型回答时不能从用户请求重跑整项任务。

重启恢复先加载结构历史与任务记录，再核对磁盘。intent 无 outcome 的命令归为未知；只有核实结果后才决定下一步。文件检查点不等于 Shell 副作用回滚，界面必须保持这一区别。

## 6. 最小交付与范围控制

先完成 R01–R08 的最小主链路，拿到真实成功案例，再补 R09–R10 提高成功率和效率。R07/R08 在最小案例后紧接完成，不能留到发布后。

一期提供输入/焦点底座，但后端修复与命令执行集成可先做。三期原有上下文“展示”仍保留；容量预算与完整工作现场提前到本期，避免职责重复。
