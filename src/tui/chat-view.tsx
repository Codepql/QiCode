import { Box, Text, useInput, useStdout } from "ink";
import { marked } from "marked";
import type { Token, Tokens } from "marked";
import {
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ConversationMessage, ToolResultBlock } from "../conversation/types.js";
import { Conversation } from "../conversation/conversation.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";
import { ToolDisplay } from "./tool-display.js";

export interface ChatViewProps {
  messages: readonly ConversationMessage[];
  streamingText?: string;
  activeTools?: readonly ActiveTool[];
  /** 滚动视口最大行数；缺省时按终端高度估算。 */
  maxHeight?: number;
}

export interface ActiveTool {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface ChatTurn {
  user: ConversationMessage | null;
  assistants: ConversationMessage[];
}

/** 未传 maxHeight 时的兜底预留行数（Header/输入区/状态栏等）。 */
const RESERVED_ROWS = 8;
/** 工具结果在 ToolDisplay 中的最大展示字符数（与 tool-display 保持一致）。 */
const TOOL_OUTPUT_PREVIEW_CHARS = 500;

export function ChatView({
  messages,
  streamingText = "",
  activeTools = [],
  maxHeight,
}: ChatViewProps) {
  const { stdout } = useStdout();
  const [scrollTop, setScrollTop] = useState(0);
  const [followBottom, setFollowBottom] = useState(true);

  const width = stdout.columns ?? 80;
  const viewportHeight = Math.max(
    1,
    maxHeight ?? (stdout.rows ?? 24) - RESERVED_ROWS,
  );

  const toolResults = new Map<string, ToolResultBlock>(
    messages.flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result")
      .map((block) => [block.toolUseId, block]),
  );
  const turns = useMemo(() => groupIntoChatTurns(messages), [messages]);
  const heights = useMemo(
    () => turns.map((turn) => estimateTurnHeight(turn, toolResults, width)),
    [turns, toolResults, width],
  );
  const totalTurnsHeight = heights.reduce((sum, height) => sum + height, 0);
  // 流式文本与加载中的工具也是「内容尾部」，要计入高度，否则跟随底部时被切出屏幕。
  const streamingSuffixRows =
    streamingText === ""
      ? 0
      : estimateTextLines(streamingText, width) + (turns.length === 0 ? 1 : 0);
  const activeSuffixRows = activeTools.length; // 每个加载中工具 1 行
  const suffixHeight = streamingSuffixRows + activeSuffixRows;
  const contentHeight = totalTurnsHeight + suffixHeight;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);

  // 默认跟随底部：新内容进来自动滚到最新一行。
  useEffect(() => {
    if (followBottom) setScrollTop(maxScroll);
  }, [followBottom, maxScroll]);

  // 手动上翻后内容变短时，把 scrollTop 钳制回合法范围。
  useEffect(() => {
    setScrollTop((previous) => Math.min(previous, maxScroll));
  }, [maxScroll]);

  useInput((_input, key) => {
    const pageStep = Math.max(1, viewportHeight - 2);
    if (key.pageUp) {
      setFollowBottom(false);
      setScrollTop((previous) => Math.max(0, previous - pageStep));
    } else if (key.pageDown) {
      const next = Math.min(maxScroll, scrollTop + pageStep);
      setScrollTop(next);
      if (next >= maxScroll) setFollowBottom(true);
    } else if (key.home) {
      setFollowBottom(false);
      setScrollTop(0);
    } else if (key.end) {
      setFollowBottom(true);
      setScrollTop(maxScroll);
    }
  });

  const range = visibleRange(turns, heights, scrollTop, viewportHeight);
  // 只有当窗口底部越过回合区（到达内容尾部）时才渲染流式文本/加载工具。
  const showSuffix = scrollTop + viewportHeight > totalTurnsHeight;
  const visibleTurns = turns.slice(range.start, range.end);

  return (
    <Box flexDirection="column">
      {visibleTurns.map((turn, index) => (
        <TurnBlock
          key={`turn-${range.start + index}`}
          turn={turn}
          toolResults={toolResults}
        />
      ))}
      {showSuffix && streamingText !== "" && (
        <Box flexDirection="column">
          {turns.length === 0 && <Text bold color="green">QiCode</Text>}
          <Text>{sanitizeTerminalText(streamingText)}</Text>
        </Box>
      )}
      {showSuffix && activeTools.length > 0 && (
        <ToolDisplay tools={activeTools.map((tool) => ({
          toolName: tool.toolName,
          args: tool.args,
          loading: true,
        }))} />
      )}
    </Box>
  );
}

/**
 * 按「用户回合」分组：一次用户提问 + 该回合内所有 assistant 消息。
 * <system-reminder> 系统提醒不显示给用户；纯 tool_result 回灌的 user 消息也不新开回合。
 */
function groupIntoChatTurns(
  messages: readonly ConversationMessage[],
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (isSystemReminder(message)) continue;
    const isUserPrompt =
      message.role === "user" &&
      Conversation.visibleText(message).trim() !== "";
    if (isUserPrompt) {
      turns.push({ user: message, assistants: [] });
    } else if (message.role === "assistant") {
      const last = turns.at(-1);
      if (last === undefined) {
        turns.push({ user: null, assistants: [message] });
      } else {
        last.assistants.push(message);
      }
    }
  }
  return turns;
}

function isSystemReminder(message: ConversationMessage): boolean {
  return (
    message.role === "user" &&
    Conversation.visibleText(message).trimStart().startsWith("<system-reminder>")
  );
}

/** 估算一个回合渲染占用的终端行数（用于滚动窗口）。 */
function estimateTurnHeight(
  turn: ChatTurn,
  toolResults: Map<string, ToolResultBlock>,
  width: number,
): number {
  let height = 0;
  if (turn.user !== null) {
    height += 1; // You
    height += estimateTextLines(Conversation.visibleText(turn.user), width);
  }
  if (turn.assistants.length > 0) {
    height += 1; // QiCode
    turn.assistants.forEach((message, index) => {
      const toolUses = message.content.filter(
        (block) => block.type === "tool_use",
      );
      // 中间带工具调用的消息是「分析/推理」过程，不直接展示。
      const isAnalysis =
        index < turn.assistants.length - 1 || toolUses.length > 0;
      const visible = Conversation.visibleText(message);
      if (!isAnalysis && visible !== "") {
        height += estimateMarkdownLines(visible, width);
      }
      for (const toolUse of toolUses) {
        height += 1; // ✓ 工具名 参数 行
        const result = toolResults.get(toolUse.id);
        if (result !== undefined && result.content !== "") {
          height += estimateTextLines(
            previewToolOutput(result.content),
            width,
          );
        }
      }
    });
  }
  height += 1; // 回合之间的 marginBottom
  return height;
}

function previewToolOutput(output: string): string {
  return output.length <= TOOL_OUTPUT_PREVIEW_CHARS
    ? output
    : `${output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS - 1)}…`;
}

/** 估算纯文本占用的终端行数（按换行与列宽折算，CJK 按 2 列）。 */
function estimateTextLines(text: string, width: number): number {
  if (text === "") return 0;
  let lines = 0;
  for (const line of text.split("\n")) {
    const columns = displayWidth(line);
    lines += Math.max(1, Math.ceil(columns / Math.max(1, width)));
  }
  return lines;
}

/** 估算 Markdown 渲染后的行数（与 renderBlocks 的结构大致对应）。 */
function estimateMarkdownLines(text: string, width: number): number {
  return estimateMarkdownLinesFromTokens(marked.lexer(text), width);
}

function estimateMarkdownLinesFromTokens(
  tokens: readonly Token[],
  width: number,
): number {
  let lines = 0;
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        lines += estimateTextLines(inlineText(heading.tokens), width);
        break;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        lines += estimateTextLines(inlineText(paragraph.tokens), width);
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        const content =
          typeof text.text === "string"
            ? text.text
            : inlineText(text.tokens ?? []);
        lines += estimateTextLines(content, width);
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        for (const item of list.items) {
          lines += estimateTextLines(inlineText(item.tokens), width);
        }
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        lines += 2 + code.text.split("\n").length;
        break;
      }
      case "blockquote": {
        const blockquote = token as Tokens.Blockquote;
        lines += estimateMarkdownLinesFromTokens(blockquote.tokens, width);
        break;
      }
      case "hr":
        lines += 1;
        break;
      case "table": {
        const table = token as Tokens.Table;
        lines += 1 + table.rows.length;
        break;
      }
      case "html": {
        const html = token as Tokens.HTML;
        lines += html.text.split("\n").length;
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

function displayWidth(text: string): number {
  let columns = 0;
  for (const char of text) {
    columns += isWideChar(char) ? 2 : 1;
  }
  return columns;
}

function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 计算当前滚动位置下应渲染的回合区间。 */
function visibleRange(
  turns: readonly ChatTurn[],
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  if (turns.length === 0) return { start: 0, end: 0 };

  let start = 0;
  let acc = 0;
  for (let index = 0; index < turns.length; index += 1) {
    if (acc + heights[index]! > scrollTop) {
      start = index;
      break;
    }
    acc += heights[index]!;
  }
  start = Math.max(0, start - 1); // 上方多留一回合作上下文

  let end = turns.length;
  let top = 0;
  for (let index = 0; index < turns.length; index += 1) {
    if (top >= scrollTop + viewportHeight) {
      end = index;
      break;
    }
    top += heights[index]!;
  }
  return { start, end };
}

function TurnBlock({
  turn,
  toolResults,
}: {
  turn: ChatTurn;
  toolResults: Map<string, ToolResultBlock>;
}) {
  const userVisible =
    turn.user === null
      ? ""
      : sanitizeTerminalText(Conversation.visibleText(turn.user));

  return (
    <Box flexDirection="column" marginBottom={1}>
      {turn.user !== null && (
        <>
          <Text bold color="cyan">You</Text>
          <Text>{userVisible}</Text>
        </>
      )}
      {turn.assistants.length > 0 && (
        <>
          <Text bold color="green">QiCode</Text>
          {turn.assistants.map((message, index) => {
            const toolUses = message.content.filter(
              (block) => block.type === "tool_use",
            );
            // 中间带工具调用的消息是「分析/推理」过程，不直接展示；
            // 只有回合最后一个（无工具调用）才是正式回答。
            const isAnalysis =
              index < turn.assistants.length - 1 || toolUses.length > 0;
            const visible = sanitizeTerminalText(
              Conversation.visibleText(message),
            );
            return (
              <Box key={`assistant-${index}`} flexDirection="column">
                {!isAnalysis && visible !== "" && (
                  <MarkdownText value={visible} />
                )}
                {toolUses.length > 0 && (
                  <ToolDisplay tools={toolUses.map((toolUse) => {
                    const result = toolResults.get(toolUse.id);
                    return result === undefined
                      ? { toolName: toolUse.name, args: toolUse.input, loading: true }
                      : {
                          toolName: toolUse.name,
                          args: toolUse.input,
                          output: result.content,
                          isError: result.isError,
                        };
                  })} />
                )}
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}
function MarkdownText({ value }: { value: string }) {
  return <Box flexDirection="column">{renderBlocks(marked.lexer(value), "root")}</Box>;
}

function renderBlocks(tokens: readonly Token[], keyPrefix: string): ReactElement[] {
  const rendered: ReactElement[] = [];

  tokens.forEach((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        rendered.push(
          <Text key={key} bold color={heading.depth === 1 ? "magenta" : "green"}>
            {renderInline(heading.tokens, key)}
          </Text>,
        );
        break;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        rendered.push(<Text key={key}>{renderInline(paragraph.tokens, key)}</Text>);
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        rendered.push(<Text key={key}>{renderTextToken(text, key)}</Text>);
        break;
      }
      case "list":
        rendered.push(renderList(token as Tokens.List, key));
        break;
      case "code": {
        const code = token as Tokens.Code;
        rendered.push(
          <Box key={key} borderStyle="single" borderColor="gray" paddingX={1}>
            <Text>{code.text}</Text>
          </Box>,
        );
        break;
      }
      case "blockquote": {
        const blockquote = token as Tokens.Blockquote;
        rendered.push(
          <Box
            key={key}
            borderStyle="single"
            borderLeft
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            paddingLeft={1}
          >
            <Box flexDirection="column">{renderBlocks(blockquote.tokens, key)}</Box>
          </Box>,
        );
        break;
      }
      case "hr":
        rendered.push(<Text key={key} dimColor>{"-".repeat(40)}</Text>);
        break;
      case "table": {
        const table = token as Tokens.Table;
        rendered.push(
          <Box key={key} flexDirection="column">
            <Text bold>{table.header.map((cell) => inlineText(cell.tokens)).join(" | ")}</Text>
            {table.rows.map((row, rowIndex) => (
              <Text key={`${key}-row-${rowIndex}`}>
                {row.map((cell) => inlineText(cell.tokens)).join(" | ")}
              </Text>
            ))}
          </Box>,
        );
        break;
      }
      case "html": {
        const html = token as Tokens.HTML;
        rendered.push(<Text key={key}>{html.text}</Text>);
        break;
      }
      default:
        break;
    }
  });

  return rendered;
}

function renderList(token: Tokens.List, key: string): ReactElement {
  return (
    <Box key={key} flexDirection="column">
      {token.items.map((item, index) => (
        <Box key={`${key}-item-${index}`} flexDirection="row">
          <Text>{token.ordered ? `${Number(token.start || 1) + index}. ` : "* "}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {renderListItem(item, `${key}-item-${index}`)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function renderListItem(item: Tokens.ListItem, keyPrefix: string): ReactElement[] {
  const rendered: ReactElement[] = [];
  const checkbox = item.task ? `[${item.checked ? "x" : " "}] ` : "";

  item.tokens.forEach((token, index) => {
    const key = `${keyPrefix}-content-${index}`;
    if (token.type === "text" || token.type === "paragraph") {
      const inlineTokens = token.tokens ?? [];
      rendered.push(<Text key={key}>{checkbox}{renderInline(inlineTokens, key)}</Text>);
    } else {
      rendered.push(...renderBlocks([token], key));
    }
  });

  return rendered;
}

function renderInline(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-inline-${index}`;
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return <Text key={key}>{renderTextToken(text, key)}</Text>;
      }
      case "strong": {
        const strong = token as Tokens.Strong;
        return <Text key={key} bold>{renderInline(strong.tokens, key)}</Text>;
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return <Text key={key} italic>{renderInline(emphasis.tokens, key)}</Text>;
      }
      case "del": {
        const deleted = token as Tokens.Del;
        return <Text key={key} strikethrough dimColor>{renderInline(deleted.tokens, key)}</Text>;
      }
      case "codespan": {
        const code = token as Tokens.Codespan;
        return <Text key={key} color="blue">{code.text}</Text>;
      }
      case "link": {
        const link = token as Tokens.Link;
        return <Text key={key} color="cyan" underline>{renderInline(link.tokens, key)}</Text>;
      }
      case "image": {
        const image = token as Tokens.Image;
        return <Text key={key}>{image.text ? `[${image.text}]` : "[image]"}</Text>;
      }
      case "br":
        return <Text key={key}>{"\n"}</Text>;
      case "escape": {
        const escape = token as Tokens.Escape;
        return <Text key={key}>{escape.text}</Text>;
      }
      default:
        return <Text key={key}>{tokenText(token)}</Text>;
    }
  });
}

function renderTextToken(token: Tokens.Text, keyPrefix: string): ReactNode {
  return token.tokens ? renderInline(token.tokens, keyPrefix) : token.text;
}

function inlineText(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens);
    return tokenText(token);
  }).join("");
}

function tokenText(token: Token): string {
  return "text" in token && typeof token.text === "string" ? token.text : "";
}
