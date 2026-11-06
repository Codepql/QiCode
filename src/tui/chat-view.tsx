import { Box, Text, useWindowSize } from "ink";
import { useMemo, useRef, useState } from "react";
import type { ConversationMessage } from "../conversation/types.js";
import { findAnchor, layoutChat, type ActiveTool } from "./chat-layout.js";
import { useRoutedInput } from "./input-router.js";

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
}

export function ChatView({ messages, streamingText = "", activeTools = [], maxHeight, columns, active = true, toolPreview = true, highContrast = false }: ChatViewProps) {
  const window = useWindowSize();
  const width = Math.max(1, columns ?? window.columns ?? 80);
  const height = Math.max(1, maxHeight ?? (window.rows ?? 24) - 8);
  const lines = useMemo(() => layoutChat(messages, streamingText, activeTools, width, toolPreview), [messages, streamingText, activeTools, width, toolPreview]);
  const contentHeight = Math.max(1, height - (lines.length > height ? 1 : 0));
  const maxScroll = Math.max(0, lines.length - contentHeight);
  const [following, setFollowing] = useState(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const scroll = useRef(0);
  const latest = `${messages.length}:${streamingText.length}:${activeTools.map((tool) => tool.toolId).join(",")}`;
  const seen = useRef(latest);
  const [, redraw] = useState(0);
  const top = following ? maxScroll : Math.min(maxScroll, anchor.current ? findAnchor(lines, anchor.current, scroll.current) : scroll.current);
  scroll.current = top;
  useRoutedInput(10, (_input, key) => {
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
    {lines.slice(top, top + contentHeight).map((line, index) => <Text key={index} wrap="truncate-end"
      {...(line.kind === "user" ? { color: "cyan" as const, bold: true }
        : line.kind === "assistant" || line.kind === "heading" ? { color: "green" as const, bold: true }
        : line.kind === "error" ? { color: "red" as const }
        : line.kind === "code" ? { color: "blue" as const }
        : line.kind === "tool" ? { dimColor: !highContrast } : {})}>{line.text || " "}</Text>)}
    {lines.length > height && <Text dimColor wrap="truncate-end">{following ? "已到最新" : `历史 ${top + 1}/${lines.length} · ${seen.current === latest ? "已暂停跟随" : "有新输出"}`} · Ctrl+End 回到最新</Text>}
  </Box>;
}
