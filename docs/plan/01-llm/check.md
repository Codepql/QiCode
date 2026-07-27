# QiCode 第一阶段完成检查：LLM 终端对话

> 状态：未执行。只有用户明确说“开发第 01 章”后，才按本清单验证实现。
>
> 需求依据：`spec.md`；技术依据：`plan.md`；实施依据：`task.md`。

## 1. 范围检查

- [ ] 只实现纯文本对话、Provider、SSE、多轮上下文和 TUI。
- [ ] 没有 Tool use、文件操作、Shell、MCP、权限、记忆或 Agent Loop 代码。
- [ ] 产品名统一为 QiCode，私有目录统一为 `.qicode`。
- [ ] Provider 配置严格为 `name / protocol / model / base_url / api_key / thinking` 六个字段。
- [ ] protocol 只允许 `anthropic` 与 `openai`；兼容端点通过 OpenAI 的 `base_url` 表达。

## 2. pnpm 与工程检查

- [ ] Node.js 22 LTS 与 pnpm 10.14.0 可用。
- [ ] `package.json.packageManager` 精确为 `pnpm@10.14.0`。
- [ ] `pnpm-lock.yaml` 存在并提交，仓库没有 `bun.lock`。
- [ ] `pnpm install --frozen-lockfile` 在干净环境成功。
- [ ] `pnpm dev` 运行 `src/main.tsx`。
- [ ] `pnpm build` 生成 `dist/main.js`，`pnpm start` 运行构建产物。
- [ ] 源码和文档不存在 Bun shebang、`@types/bun`、`Bun.*` 或 Bun 命令。

## 3. 配置检查

- [ ] 默认读取 `~/.qicode/config.yaml`，`--config <path>` 可覆盖。
- [ ] 合法的单 Provider 配置直接进入对话。
- [ ] 多 Provider 配置显示选择列表，方向键移动、Enter 确认。
- [ ] 缺文件、非法 YAML、空 providers、字段缺失、重复 name 和非法 URL 均返回 `ConfigError`。
- [ ] `${ENV_NAME}` API Key 引用可解析，缺失环境变量时启动失败。
- [ ] `thinking: true` 用于 OpenAI 时配置校验失败。
- [ ] 所有配置错误都不会打印 API Key 或完整原始配置。

## 4. Provider 与 SSE 检查

- [ ] `Provider` 接口与 `createProvider` 工厂不依赖 Ink。
- [ ] Anthropic 与 OpenAI Provider 输出统一 `StreamEvent`。
- [ ] SSE 解析覆盖 chunk 拆分、一个 chunk 多事件、LF、CRLF、多行 data 和 UTF-8 跨 chunk。
- [ ] SSE 单事件和累计缓冲具有上限。
- [ ] Anthropic 请求和事件映射通过本地模拟服务测试。
- [ ] OpenAI Chat Completions 请求和事件映射通过本地模拟服务测试。
- [ ] `base_url` 有无 `/v1` 和尾斜杠都生成正确且不重复的资源 URL。
- [ ] 401、429、上下文过长、非法 JSON、网络中断、超时和取消被统一分类。

## 5. Extended Thinking 检查

- [ ] `thinking: true` 时 Anthropic 请求包含正确 thinking 参数。
- [ ] thinking delta 不进入可见正文。
- [ ] thinking 内容和 signature 以隐藏块保存在内存会话中。
- [ ] 下一轮 Anthropic 请求恢复完整 thinking block 与 signature。
- [ ] OpenAI Provider 只发送文本历史，不发送 Anthropic thinking block。

## 6. 多轮与错误恢复检查

- [ ] 用户消息提交后立即进入历史。
- [ ] 完成的助手正文进入历史，第二轮请求携带第一轮上下文。
- [ ] 流式断开时保留已收到正文，并重新启用输入。
- [ ] 单轮 Provider 错误不会退出应用。
- [ ] 同一时间最多一个请求，退出或超时会取消网络流并清理计时器。
- [ ] 退出进程后历史清空，本章不写会话文件。

## 7. TUI 检查

- [ ] 顶部只显示一次三行双栏 Header：左侧严格为 `/\_/\`、`( o.o )`、`> ^ <` 三行猫头，右侧依次为版本、`protocol · model`、工作目录；字符画不进入对话历史或重复渲染。
- [ ] 两栏通过 Ink 布局间距对齐，不依赖尾随空格；窄终端或高度不足时猫头自动隐藏并降级为三行纯文本信息，状态栏和边框不发生错位。
- [ ] 历史按 `You` 与 `QiCode` 分组，窄终端下可读。
- [ ] 流式期间显示纯文本，完成后再进行 Markdown 终端渲染。
- [ ] 用户与模型文本在 Markdown 解析前清理 ANSI、OSC 和危险控制字符。
- [ ] Enter 提交，空内容不提交；界面不宣称支持不可用的键盘换行。
- [ ] waiting/streaming 时不能重复提交。
- [ ] usage 缺失时显示 `-`，不伪造 token。
- [ ] `/exit` 直接退出；第一次 `Ctrl+C` 只取消当前请求并提示，1.5 秒内第二次 `Ctrl+C` 才退出；退出后光标与输入模式正常。

## 8. 自动化验证

- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过，无 skip/only 测试。
- [ ] `pnpm build` 通过。
- [ ] `pnpm audit --prod` 的结果已按运行时可达性审查，无未处理的高危问题。
- [ ] 本地模拟 HTTP 服务覆盖 Anthropic/OpenAI 的正常、异常、取消和部分响应路径。

## 9. 真实端到端场景

- [ ] Anthropic 普通模式完成至少两轮流式对话。
- [ ] Anthropic thinking 模式完成至少两轮，界面不显示思考文本。
- [ ] OpenAI 官方或兼容端点完成至少两轮流式对话。
- [ ] 错误 Key 显示安全错误且应用可继续使用。
- [ ] 模拟断流后已收到正文被保留。
- [ ] 单 Provider、多 Provider、窄终端与安全退出均手工验证。

## 10. 学习与面试交付

- [ ] 根据最终代码生成本章学习文档，而不是复述规划。
- [ ] 文档包含一轮对话完整调用链和准确文件/行号。
- [ ] 文档解释 Node、pnpm、Ink、SSE、AsyncGenerator、Provider 和多轮上下文。
- [ ] 高频问题提供一句话、项目回答、深挖追问和当前不足四层答案。
- [ ] 调试章节列出入口、配置、请求体、原始 SSE、统一事件、TUI 聚合和历史提交断点。
- [ ] 每个断点说明观察变量、正常值、异常含义和下一步追踪位置。
- [ ] 至少包含拆包、错误 Key、断流、超时和 extended thinking 五个故障实验。
- [ ] 包含一个由学习者独立完成的小改动，并在完成后接受代码 Review。

## 11. 完成准则

只有以上适用项目全部完成，并且 `spec.md` 每条验收标准都有自动或手工证据时，第 01 章才可标记完成。
