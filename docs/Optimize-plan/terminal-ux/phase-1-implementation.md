# 第一期实现与验收记录

日期：2026-11-06。基线：v0.1.6 / `2021d9d`。状态：功能代码已实现，自动化验证已完成；真实终端人工验收待执行，不宣称所有平台已通过发布门槛。

## 已实现范围

| 需求 | 实现 | 验证位置 |
| --- | --- | --- |
| P1-01 编辑器 | 多行、字素级移动/删除、逐词编辑、视觉行导航、当前项目本进程最近 100 条输入、草稿恢复、动态高度，硬件光标定位 | `tests/tui/editor-state.test.ts`、`interaction.test.tsx`、`terminal-protocol.test.tsx` |
| P1-02 粘贴 | Ink bracketed paste 独立通道、分片重组、换行归一化、控制序列过滤、多个折叠块、完整正文发送、1 MiB UTF-8 原子拒绝、手动粘贴模式 | 编辑状态测试及分片/千行粘贴交互测试 |
| P1-03 焦点 | 单一按优先级消费的路由；模态、通知、编辑器与聊天隔离；候选跟随选中项；Shift+Tab 不再监听原始 process.stdin | 交互测试的模态隔离、候选翻页与终端协议测试 |
| P1-04 视口 | 统一 Markdown/文本行布局、真实可见行裁剪、500 行单回复遍历、阅读锚点、暂停/恢复跟随、鼠标滚动、缓存历史行 | 交互测试的逐页全覆盖、流式更新和宽度变化 |
| P1-05 布局 | Yoga 分配真实剩余高度、原三行猫咪 Logo 与 Header 原样保留、团队按需打开、长通知与弹窗可滚动、极小窗口保护、退出模式清理 | 布局、缩放、极小窗口及模拟交互 TTY 协议测试 |

新增基础模块：`editor-state.ts` 管编辑与粘贴范围；`text-layout.ts` 管字素和显示列；`input-router.tsx` 管事件消费；`chat-layout.ts` 管实际内容行；`terminal-frame.tsx` 管区域尺寸；`notice-panel.tsx` 管有界通知。

继续沿用 Ink、React、marked 和现有 Agent/权限/命令注册。不增加依赖，不改 Provider、工具执行语义和文件检查点策略；权限请求增加唯一 ID，避免连续弹窗复用已完成的选择状态。输入历史仅驻留本进程，不把提示词另写入持久历史文件。

## 操作约定

- Enter 发送；Ctrl+J、可识别的 Shift+Enter/Alt+Enter 换行。按键配置页面留到第三期，当前提供固定兼容键。
- Alt+V 或 Ctrl+V 切换手动粘贴模式，模式内 Enter 只换行。Ctrl+V 被宿主终端用于粘贴时使用 Alt+V。
- 超过 10 行或 2,000 字符的粘贴折叠，Ctrl+O 展开/折叠；折叠块保留原文，删除边界可移除整块。
- 粘贴内容带 literal 标记；即使粘贴 `/exit`，显式发送也作为正文，不直接触发退出。手动键入 Slash 命令仍走原命令注册与分发。
- PageUp/PageDown 专用于聊天翻页，Ctrl+Home/End 到顶部/最新。方向键与 Home/End 先用于编辑或当前列表。
- 权限弹窗 Esc/Ctrl+C 拒绝本次请求；团队/通知面板先返回或关闭；其余执行中 Esc/Ctrl+C 取消任务，空闲两秒内两次 Ctrl+C 退出。
- 小于 40×10 时隐藏交互区、保留草稿，并阻止隐藏确认和提交；只保留取消/退出通道。

## 自动化验证

最终全量结果：55 个测试文件通过，303 项测试通过、1 项跳过；类型检查、构建和 `git diff --check` 通过。

新增测试覆盖 Unicode 字素、UTF-8 限制、格式清洗、多粘贴范围、分片 bracketed paste、连续按键、候选窗口、弹窗隔离、输入历史、完整长回复访问、阅读锚点、窗口保护。

模拟交互 TTY 验证硬件光标位置（提示符加两个中文字符位于第 7 列），并验证分片鼠标包不污染输入、卸载时恢复 raw/bracketed-paste/mouse 模式。此测试验证发送的终端协议，不等价于真实输入法候选窗口验收。

工程命令使用项目现有脚本。当前宿主 pnpm 自动切换包管理器版本遇沙箱符号链接限制时，以 `--manage-package-manager-versions=false` 禁用自动安装，仅运行已有依赖；Vitest 的缓存重命名需在允许的执行环境中进行。

```powershell
pnpm.cmd --manage-package-manager-versions=false typecheck
pnpm.cmd --manage-package-manager-versions=false test
pnpm.cmd --manage-package-manager-versions=false build
```

一轮本地纯布局探测（Windows / Node，使用构建产物；非真实终端端到端计时）：50 轮、10,000 行历史首次布局约 782ms，历史缓存后的 30 次流式更新布局 p95 约 2.3ms，5,000 行文本插入与折叠投影约 0.7ms。首次布局开销仍需在真实大历史场景观察；这些数据不能替代原规划的 UI 延迟、长期内存和 30 分钟稳定性验收。

## 尚未验证的发布门槛

- Windows Terminal + PowerShell 7 和 VS Code 集成终端：真实中文输入法候选定位、Shift+Enter 报告能力、鼠标选择复制。
- 真实窗口连续 20 次缩放，覆盖输入、持续输出、候选和授权；当前自动化仅覆盖尺寸模拟与协议行为。
- 30 分钟持续使用及端到端 p95 指标，macOS/Linux/tmux 兼容性。

本期没有实现运行中 steering、后续任务队列、工具完整日志浏览、模型选择或完整会话恢复；这些按新版第二、三期规划推进。不要据本期 UI 自动测试推断真实编码任务成功率已提高。
