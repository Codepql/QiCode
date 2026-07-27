import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { ProviderConfig } from "../config/types.js";
import { Conversation } from "../conversation/conversation.js";
import type { ConversationBlock, ConversationMessage } from "../conversation/types.js";
import { createProvider } from "../providers/create-provider.js";
import { formatProviderError } from "../providers/errors.js";
import type { Provider } from "../providers/types.js";
import { buildSystemPrompt } from "../prompt/system-prompt.js";
import { VERSION } from "../version.js";
import { Activity } from "./activity.js";
import { ChatView } from "./chat-view.js";
import { Header } from "./header.js";
import { InputBox } from "./input-box.js";
import { ProviderSelect } from "./provider-select.js";
import { StatusBar } from "./status-bar.js";

type TurnStatus = "idle" | "waiting" | "streaming" | "failed";

export interface AppProps {
  providers: readonly ProviderConfig[];
  workDir?: string;
  requestTimeoutMs?: number;
}

export function App({
  providers,
  workDir = process.cwd(),
  requestTimeoutMs = 120_000,
}: AppProps) {
  const { exit } = useApp();
  const [selectedConfig, setSelectedConfig] = useState<ProviderConfig | undefined>(
    providers.length === 1 ? providers[0] : undefined,
  );
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<TurnStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [exitHint, setExitHint] = useState("");
  const [inputTokens, setInputTokens] = useState<number>();
  const [outputTokens, setOutputTokens] = useState<number>();
  const [startedAt, setStartedAt] = useState(Date.now());
  const conversationRef = useRef(new Conversation());
  const providerRef = useRef<Provider | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastCtrlCRef = useRef(0);
  const exitHintTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
  }, []);

  useEffect(() => {
    providerRef.current = selectedConfig ? createProvider(selectedConfig) : undefined;
  }, [selectedConfig]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current <= 1_500) {
        exit();
        return;
      }

      lastCtrlCRef.current = now;
      abortRef.current?.abort();
      setExitHint("Press Ctrl+C again within 1.5s to exit.");
      if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
      exitHintTimerRef.current = setTimeout(() => {
        lastCtrlCRef.current = 0;
        setExitHint("");
      }, 1_500);
    }
  });

  if (!selectedConfig) {
    return (
      <Box flexDirection="column">
        <Text bold color="magenta">QiCode</Text>
        <ProviderSelect providers={providers} onSelect={setSelectedConfig} />
      </Box>
    );
  }

  const busy = status === "waiting" || status === "streaming";

  async function submit(rawText: string): Promise<void> {
    const provider = providerRef.current;
    const config = selectedConfig;
    if (busy || !provider || !config) return;
    if (rawText.trim() === "/exit") {
      exit();
      return;
    }

    conversationRef.current.addUserMessage(rawText);
    setMessages(conversationRef.current.getMessages());
    setStreamingText("");
    setErrorMessage("");
    setInputTokens(undefined);
    setOutputTokens(undefined);
    setStatus("waiting");
    setStartedAt(Date.now());

    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    let text = "";
    let thinking = "";
    let signature = "";

    try {
      for await (const event of provider.stream({
        systemPrompt: buildSystemPrompt(workDir),
        messages: conversationRef.current.getMessages(),
        signal: controller.signal,
      })) {
        if (event.type === "text_delta") {
          text += event.text;
          setStreamingText(text);
          setStatus("streaming");
        } else if (event.type === "thinking_delta") {
          thinking += event.thinking;
          setStatus("streaming");
        } else if (event.type === "thinking_complete") {
          thinking = event.thinking;
          signature = event.signature;
        } else if (event.type === "usage") {
          if (event.inputTokens !== undefined) setInputTokens(event.inputTokens);
          if (event.outputTokens !== undefined) setOutputTokens(event.outputTokens);
        }
      }
      commitAssistant(text, thinking, signature);
      setStatus("idle");
    } catch (error) {
      commitAssistant(text, thinking, signature);
      setErrorMessage(
        timedOut
          ? "Request timed out. You can continue the conversation."
          : formatProviderError(error, [config.api_key]),
      );
      setStatus("failed");
    } finally {
      clearTimeout(timeout);
      abortRef.current = undefined;
      setStreamingText("");
    }
  }

  function commitAssistant(text: string, thinking: string, signature: string): void {
    const content: ConversationBlock[] = [];
    if (thinking && signature) {
      content.push({ type: "thinking", thinking, signature, hidden: true });
    }
    if (text) content.push({ type: "text", text });
    if (content.length > 0) {
      conversationRef.current.addAssistantMessage(content);
      setMessages(conversationRef.current.getMessages());
    }
  }

  return (
    <Box flexDirection="column">
      <Header version={VERSION} model={selectedConfig.model} workDir={workDir} />
      <ChatView messages={messages} streamingText={streamingText} />
      <Activity active={busy} label={status === "waiting" ? "Waiting" : "Thinking"} startedAt={startedAt} />
      {errorMessage && <Text color="red">Error: {errorMessage}</Text>}
      {exitHint && <Text color="yellow">{exitHint}</Text>}
      <Box marginTop={1} flexDirection="column">
        <InputBox disabled={busy} onSubmit={(value) => void submit(value)} />
        <StatusBar
          model={selectedConfig.model}
          {...(inputTokens === undefined ? {} : { inputTokens })}
          {...(outputTokens === undefined ? {} : { outputTokens })}
        />
      </Box>
    </Box>
  );
}
