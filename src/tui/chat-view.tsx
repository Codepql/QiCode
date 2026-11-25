import { Box, Text, useWindowSize } from "ink";
import { useMemo, useRef, useState } from "react";
import type { ConversationMessage } from "../conversation/types.js";
import { findAnchor, layoutChat, type ActiveTool, type ChatLine } from "./chat-layout.js";
import { useRoutedInput } from "./input-router.js";
import { theme } from "./theme.js";
import { readToolLogPage, toolLogPageBytes, type ToolLogPage } from "./tool-log-page.js";

export type { ActiveTool } from "./chat-layout.js";
export interface ChatViewProps {
  messages: readonly ConversationMessage[];
  streamingText?: string;
  activeTools?: readonly ActiveTool[];
  maxHeight?: number;
  columns?: number;
  active?: boolean;
  toolPreview?: boolean;
  highContrast?: boolean;
  workDir?: string;
}

export function ChatView({ messages, streamingText = "", activeTools = [], maxHeight, columns, active = true, toolPreview = true, highContrast = false, workDir }: ChatViewProps) {
  const window = useWindowSize();
  const width = Math.max(1, columns ?? window.columns ?? 80);
  const height = Math.max(1, maxHeight ?? (window.rows ?? 24) - 8);
  const [selected, setSelected] = useState<string>();
  const [opened, setOpened] = useState<{ id: string; page?: ToolLogPage; notice?: string }>();
  const logRequest = useRef(0);
  const results = useMemo(() => new Map(messages.flatMap((message) => message.content).flatMap((block) => block.type === "tool_result" ? [[block.toolUseId, block] as const] : [])), [messages]);
  const openedId = opened?.id;
  const page = opened?.page;
  const hint = page ? `日志 ${page.offset}–${Math.min(page.offset + toolLogPageBytes, page.total)} / ${page.total} 字节 · Alt+PgUp/PgDn 翻页` : opened?.notice;
  const lines = useMemo(() => layoutChat(messages, streamingText, activeTools, width, toolPreview, openedId ? { id: openedId, ...(page ? { output: page.text } : {}), ...(hint ? { hint } : {}) } : undefined, selected), [messages, streamingText, activeTools, width, toolPreview, openedId, page, hint, selected]);
  const contentHeight = Math.max(1, height - (lines.length > height ? 1 : 0));
  const maxScroll = Math.max(0, lines.length - contentHeight);
  const [following, setFollowing] = useState(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const scroll = useRef(0);
  const beforeOpen = useRef<{ following: boolean; anchor: { id: string; offset: number } | null; top: number } | undefined>(undefined);
  const latest = `${messages.length}:${streamingText.length}:${activeTools.map((tool) => tool.toolId).join(",")}`;
  const seen = useRef(latest);
  const [, redraw] = useState(0);
  const top = following ? maxScroll : Math.min(maxScroll, anchor.current ? findAnchor(lines, anchor.current, scroll.current) : scroll.current);
  scroll.current = top;
  function loadPage(id: string, offset: number) {
    const path = results.get(id)?.display?.logPath;
    const token = ++logRequest.current;
    if (!path || !workDir) { setOpened({ id }); return; }
    setOpened({ id, notice: "读取日志…" });
    void readToolLogPage(workDir, path, offset).then((next) => {
      if (token === logRequest.current) setOpened({ id, page: next });
    }, () => {
      if (token === logRequest.current) setOpened({ id, notice: "完整日志不可用，显示会话内结果。" });
    });
  }
  useRoutedInput(25, (input, key) => {
    if (!key.meta || key.ctrl) return false;
    if (page && openedId && (key.pageUp || key.pageDown)) {
      if (key.pageUp && page.offset === 0 || key.pageDown && page.offset + toolLogPageBytes >= page.total) return true;
      const index = lines.findIndex((line) => line.id === `tool:${openedId}`);
      const line = lines[index];
      if (line) anchor.current = { id: line.id, offset: line.offset };
      setFollowing(false);
      loadPage(openedId, page.offset + (key.pageUp ? -toolLogPageBytes : toolLogPageBytes));
      return true;
    }
    if (input !== "o" && !key.upArrow && !key.downArrow) return false;
    const tools = lines.flatMap((line, index) => line.offset === 0 && line.id.startsWith("tool:") && results.has(line.id.slice(5)) ? [{ id: line.id.slice(5), index, line }] : []);
    const current = tools.findIndex((entry) => entry.id === selected);
    const nearest = tools.findLastIndex((entry) => entry.index < top + contentHeight);
    if (input === "o" && openedId && (!selected || selected === openedId)) {
      logRequest.current++;
      setOpened(undefined);
      setSelected(undefined);
      if (beforeOpen.current) { scroll.current = beforeOpen.current.top; anchor.current = beforeOpen.current.anchor; setFollowing(beforeOpen.current.following); }
      beforeOpen.current = undefined;
      return true;
    }
    const target = tools[Math.max(0, Math.min(tools.length - 1, input === "o" ? (current < 0 ? nearest : current) : (current < 0 ? nearest : current + (key.upArrow ? -1 : 1))))];
    if (!target) return false;
    if (input === "o") {
      beforeOpen.current ??= { following, anchor: anchor.current, top };
      loadPage(target.id, 0);
    }
    setSelected(target.id);
    anchor.current = { id: target.line.id, offset: target.line.offset };
    setFollowing(false);
    return true;
  }, active);
  useRoutedInput(10, (_input, key) => {
    if (key.meta && (key.pageUp || key.pageDown)) return false;
    let next = scroll.current;
    if (key.wheel !== undefined) next += key.wheel;
    else if (key.pageUp) next -= Math.max(1, contentHeight - 1);
    else if (key.pageDown) next += Math.max(1, contentHeight - 1);
    else if (key.home && key.ctrl) next = 0;
    else if (key.end && key.ctrl) next = maxScroll;
    else return false;
    next = Math.max(0, Math.min(maxScroll, next));
    const line = lines[next];
    anchor.current = line ? { id: line.id, offset: line.offset } : null;
    scroll.current = next;
    seen.current = latest;
    setFollowing(next >= maxScroll);
    redraw((value) => value + 1);
    return true;
  }, active);
  return <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
    {!lines.length && height >= 5 && <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
      <Text bold>从一个具体任务开始</Text>
      <Text dimColor wrap="truncate-end">描述需求、粘贴报错，或用 @ 引用文件。</Text>
      {height >= 8 && <Text dimColor wrap="truncate-end">/resume 会话 · /model 模型 · /settings 偏好</Text>}
    </Box>}
    {lines.slice(top, top + contentHeight).map((line, index) => <Text key={index} wrap="truncate-end"
      {...(line.kind === "user" ? { color: theme.accent, bold: true }
        : line.kind === "assistant" ? { color: theme.muted }
        : line.kind === "heading" ? { color: theme.accent, bold: true }
        : line.kind === "error" ? { color: theme.danger }
        : line.kind === "tool" ? { dimColor: !highContrast } : {})}>{renderLine(line)}</Text>)}
    {lines.length > height && <Text dimColor wrap="truncate-end">{following ? "已到最新" : `历史 ${top + 1}/${lines.length} · ${seen.current === latest ? "已暂停跟随" : "有新输出"}`} · Ctrl+End 回到最新</Text>}
  </Box>;
}

function renderLine(line: ChatLine) {
  if (!line.spans?.length) return line.text || " ";
  const parts = []; let offset = 0;
  for (const span of line.spans) {
    if (span.start > offset) parts.push(line.text.slice(offset, span.start));
    parts.push(<Text key={`${span.start}:${span.end}`} bold={!!span.bold || !!span.code} italic={!!span.italic} strikethrough={!!span.strike} underline={!!span.link} {...(span.code ? { color: theme.accent } : {})}>{line.text.slice(span.start, span.end)}</Text>);
    offset = span.end;
  }
  if (offset < line.text.length) parts.push(line.text.slice(offset));
  return parts;
}
