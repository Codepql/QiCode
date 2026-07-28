# QiCode 第02阶段完成检查：工具系统

> 状态：部分完成（2026-07-28）。自动化验证已通过；需要真实密钥和终端的手工验收仍待执行。
>
> 需求依据：`spec.md`；技术依据：`plan.md`；实施依据：`task.md`。

> 每一项通过 `pnpm typecheck` + `pnpm test` + 真实跑 `pnpm dev` 来验证，聚焦系统行为；括号内为验证方式与对应需求。

## 实现完整性

- [ ] `ToolRegistry` 导出 6 条工具定义且按名可查（验证：`pnpm test -- tests/tools/registry.test.ts`，断言 `getAllSchemas("anthropic").length === 6`、`getAllSchemas("openai")` 每项形如 `{ type: "function", function: {...} }`、`get("Bash")` 命中、`get("Nope")` 为 `undefined`）。(AC1/F1)
- [ ] `ReadFile` 带行号读出内容；读不存在 / 目录返回结构化错误（验证：`pnpm test -- tests/tools/read-file.test.ts` 三情形 + 手测读 `docs/typescript/第 02 章/spec.md` 见 `1\t...`）。(AC2/F2)
- [ ] `WriteFile` 创建 / 覆盖文件，父目录自动创建（验证：`pnpm test -- tests/tools/write-file.test.ts` 写 `mkdtempSync/a/b/c.txt` 后 `existsSync` true、`readFileSync` 内容一致、输出含 `(N lines)`）。(AC3/F2)
- [ ] `EditFile` 唯一匹配替换成功；0 处与 >1 处返回**可区分**错误（含匹配数）；`replace_all: true` 时多次匹配也成功（验证：`pnpm test -- tests/tools/edit-file.test.ts` 四情形）。(AC4/F2)
- [ ] `Bash` 返回 stdout/stderr/退出码；超时命令被终止并返回 `Error: command timed out after Ns`；`grep` / `diff` 退出 1 不被标 `isError`（验证：`pnpm test -- tests/tools/bash.test.ts` 三情形）。(AC5/F2/N1)
- [ ] `Glob` 用 `fast-glob` 列出匹配文件、按 mtime 倒序；`Grep` 返回 `file:line:content`（验证：`pnpm test -- tests/tools/{glob,grep}.test.ts` 命中已知关键字与 `**/*.ts`）。(AC6/F2)
- [x] 流式工具调用解析正确：Anthropic `partial_json` 与 OpenAI `tool_calls[*].arguments` 都由 Provider 拼成完整 JSON。（`tests/providers/{anthropic,openai}.test.ts`）(AC7/F4)
- [x] 单轮闭环：第一批工具执行并回灌后，第二次模型请求生成最终文本。（`tests/agent/agent.test.ts`）(AC8/F5/F6)
- [x] 单轮上限：第二次请求仍产生工具调用时会显示上限错误且不执行第二批。（`tests/agent/agent.test.ts`）(AC9/F6)
- [ ] 工具行 Claude Code 风格：执行中 `● ToolName args`（magenta `●`），结束 `✓` / `✗ ToolName args (Ns)` + 缩进结果摘要，过长截断为 `…`（验证：端到端跑一次工具任务，肉眼比对终端输出 + scrollback 顺序正确）。(AC11/F8)
- [ ] 工具失败结构化回灌且 UI 可区分、程序不退出（验证：读不存在文件 / edit 匹配不到 / bash 非零退出，各触发后再正常发一条对话继续）。(AC12/F9/N4)

## 集成

- [ ] 两协议工具流程一致：分别用 Anthropic、OpenAI 官方地址与 OpenAI 兼容地址运行同一任务；protocol 始终只有 `anthropic` / `openai`，上层行为一致。(AC10/F3/F7/N3)
- [x] 结果回灌进历史并被第二轮请求携带：`Conversation.addAssistantMessage` / `addToolResultsMessage` 与两个 Provider 历史映射均已覆盖。（`tests/agent/agent.test.ts`、`tests/providers/{anthropic,openai}.test.ts`）(F6/F7)
- [ ] 工具执行不阻塞界面：执行期间 `ChatMessage(role: "tool_use", loading)` 在动态区渲染 `● ToolName args`，Ink Spinner 持续旋转，键盘可响应（验证：跑一个稍慢的 bash 命令观察界面不冻结）。(N2)
- [ ] scrollback 顺序正确：preamble 文本 → 工具行 → 结果摘要 → 最终答复 按序通过 `<Static>` 提交不交错（验证：多工具任务后回滚查看顺序）。(F8)
- [x] 结果体量受控：`ReadFile` 默认 2000 行；`Bash` 10 MB；`Glob` 1000；`Grep` 500；Agent 层 `MAX_TOOL_OUTPUT_CHARS = 10000` 兜底。（`tests/agent/agent.test.ts`）(AC13/N5)
- [ ] 系统提示词体现 Agent 角色：`usingToolsSection` / `executingActionsSection` 拼进 `buildSystemPrompt`，问「你能做什么」答复提及 ReadFile / Bash / Glob / Grep 等能力（验证：发一条询问，观察答复）。(F3)

## 编译与测试

- [x] `pnpm typecheck` 无错误（2026-07-28）。
- [x] `pnpm test` 通过：22 files、112 tests（2026-07-28）。
- [ ] `pnpm dev` 能启动并进入 chat 界面，无 React/Ink 报错。
- [ ] 密钥不回显 / 不打印：终端输出与 scrollback 均不出现 `api_key` 或具体密钥值（验证：跑完整对话流程后通读输出，`grep -i "api_key" <log>` 无明文）。(N6)

## 端到端场景

- [ ] 场景 1（读文件并总结）：用 `protocol: openai（兼容端点）` 配置 → 问「读 docs/typescript/第 02 章/spec.md 用一句话总结」→ `● ReadFile docs/typescript/第 02 章/spec.md` 工具行 + 结束态 `✓ ReadFile docs/typescript/第 02 章/spec.md (Ns)` + 缩进结果摘要 + 最终 markdown 答复 → `/exit` 退出，终端无残留。
- [ ] 场景 2（写 / 改 / 执行链路）：让模型「新建 `/tmp/qicode-demo.txt` 写入 `hello`，再用 bash 查看它」→ 观察 `WriteFile` 与 `Bash` 工具行依次出现、`✓` 结束、`cat` 结果含 `hello`（单轮内多工具顺序执行）。
- [ ] 场景 3（错误恢复）：让模型 `EditFile` 一段不存在的文本 → 工具返回 `Error: old_string not found in file` 结构化错误、UI `✗` 红色标记、程序不退出 → 用户再正常发一条继续对话。
- [ ] 场景 4（跨协议）：Anthropic、OpenAI 官方地址和 OpenAI 兼容地址分别重跑场景 1，不出现第三种 protocol 或第二套 OpenAI Provider。
- [ ] 场景 5（结果截断）：构造一个 3000 行文件让模型 `ReadFile`（不带 `limit`），观察工具结果在 2000 行处截断；构造高密度命中让模型 `Grep`，观察尾部 `(results truncated at 500 matches)`。
## 学习与面试验收

- [ ] 学习文档来自最终代码，文件名、函数名和行号均已核对。
- [ ] 文档能从入口讲到本章核心行为完成，包含关键状态变化。
- [ ] 高频问题包含设计原因、替代方案、当前局限和继续追问。
- [ ] 调试步骤已实际走通，断点与观察变量有效。
- [ ] 至少三个故障实验可重复，并解释症状、根因和定位路径。
- [ ] 学习者完成一个独立小改动并通过测试与 Review。

## 完成准则

只有本清单适用项目全部完成，且 `spec.md` 每项验收标准都有自动化或手工证据时，第 02 章才可标记完成。
