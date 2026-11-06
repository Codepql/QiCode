import type { BackgroundTaskSnapshot } from "../agents/task-manager.js";
import type { TeammateUIState } from "../teams/progress.js";
import type { Choice } from "./choice-dialog.js";
import type { UiPreferences } from "./preferences.js";
import { readGitState } from "../worktree/git-state.js";

export interface PrimaryTask { id: string; title: string; status: string; action: string; detail: string; started: number; liveOutput?: string }
export function taskChoices(primary: PrimaryTask | undefined, background: readonly BackgroundTaskSnapshot[], teammates: readonly TeammateUIState[], workDir: string): Choice[] {
  const location = `启动工作目录：${workDir}\n当前分支：${readGitState(workDir)?.branch || "未知 / 非 Git / detached HEAD"}\n工具创建的独立目录请核对 Worktree 输出，后台执行目录不能由启动目录推断。`;
  return [
    ...(primary ? [{ id: "primary", label: `主任务 · ${primary.status} · ${primary.title}`, detail: `${primary.title}\n状态：${primary.status}\n最近动作：${primary.action}\n开始：${new Date(primary.started).toLocaleString()}\n${location}\n${primary.detail}\n${primary.liveOutput ?? ""}` }] : []),
    ...background.map((task) => ({ id: `background:${task.id}`, label: `后台 · ${task.status} · ${task.description}`, detail: `${task.id}\n${task.description}\n状态：${task.status}\n${location}\n${task.result ?? task.error ?? "尚无最终输出"}` })),
    ...teammates.map((member) => ({ id: `member:${member.teamName}:${member.name}`, label: `团队 ${member.teamName} · ${member.name} · ${member.status}`, detail: `${member.name}\n状态：${member.status}\n${location}\n${JSON.stringify(member.progress.recentActivities, null, 2)}` })),
  ];
}
export function settingsChoices(preferences: UiPreferences, source: string): Choice[] {
  return [
    { id: "compact", label: `紧凑布局：${preferences.compact ? "开启" : "关闭"}` },
    { id: "toolPreview", label: `工具结果默认预览：${preferences.toolPreview ? "开启" : "折叠"}`, detail: "关闭后聊天保留工具名称和执行状态，完整结果可从 /tasks 预览。" },
    { id: "highContrast", label: `高对比度：${preferences.highContrast ? "开启" : "关闭"}`, detail: "增强正文工具输出和状态栏的亮度；保留原有 Logo 与颜色体系。" },
    { id: "defaultMode", label: `下次启动权限：${preferences.defaultMode}`, detail: "按 Enter 在 default / acceptEdits / plan 间切换，不持久化全放行权限。当前任务的权限不受此设置影响。" },
    { id: "reset", label: "恢复默认偏好", detail: `配置来源：${source}\n恢复布局、显示、首选模型、按键与下次启动权限的默认值。不会修改 Provider 配置。` },
  ];
}
export function hotkeyHelp(preferences: UiPreferences): string {
  return ["当前有效快捷键", ...Object.entries(preferences.bindings).map(([action, chord]) => `${chord}：${action}`),
    "Enter 发送 · Ctrl+J 换行 · Alt+V 粘贴模式 · Ctrl+O 展开粘贴", "Alt+Q 取回任务补充 · @路径 + Tab 搜索文件 · PgUp/PgDn 浏览", "Ctrl+T 团队 · Shift+Tab 权限 · Esc 关闭弹窗/取消任务 · Ctrl+C 取消/两次退出",
    "弹窗：输入搜索 · ↑↓ 选择 · Tab 预览 · Enter 确认 · Esc 返回；任务面板 Ctrl+X 取消所选任务",
    "授权：Y 允许本次 · T 允许本任务编辑/普通命令（可用时） · A 记住这条操作 · N 拒绝，无需回车",
    "配置：/settings bind <sessions|models|tasks|settings> <alt+s|alt+m|alt+t|alt+b|alt+n>",
    "快捷键冲突会拒绝保存；编辑器保留键不可重绑定。界面提示使用中文，模型回复语言由任务决定。"].join("\n");
}
