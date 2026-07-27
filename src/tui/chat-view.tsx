import { Box, Text } from "ink";
import { marked } from "marked";
import type { Token, Tokens } from "marked";
import type { ReactElement, ReactNode } from "react";
import type { ConversationMessage } from "../conversation/types.js";
import { Conversation } from "../conversation/conversation.js";
import { sanitizeTerminalText } from "./sanitize-terminal.js";

export interface ChatViewProps {
  messages: readonly ConversationMessage[];
  streamingText?: string;
}

export function ChatView({ messages, streamingText = "" }: ChatViewProps) {
  return (
    <Box flexDirection="column">
      {messages.map((message, index) => {
        const visible = sanitizeTerminalText(Conversation.visibleText(message));
        if (!visible) return null;
        return (
          <Box key={`${message.role}-${index}`} flexDirection="column" marginBottom={1}>
            <Text bold color={message.role === "user" ? "cyan" : "green"}>
              {message.role === "user" ? "You" : "QiCode"}
            </Text>
            {message.role === "assistant"
              ? <MarkdownText value={visible} />
              : <Text>{visible}</Text>}
          </Box>
        );
      })}
      {streamingText && (
        <Box flexDirection="column">
          <Text bold color="green">QiCode</Text>
          <Text>{sanitizeTerminalText(streamingText)}</Text>
        </Box>
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
        return <Text key={key} color="yellow">{code.text}</Text>;
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
