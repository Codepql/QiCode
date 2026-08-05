import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { Agent } from "../agent/agent.js";
import type { ProviderConfig } from "../config/types.js";
import { Conversation } from "../conversation/conversation.js";
import type { ConversationMessage } from "../conversation/types.js";
import { createProvider, formatProviderError, type Provider } from "../llm/client.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import {
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
  getPlanPath,
  planFileExists,
} from "../prompt/plan-mode.js";
import type { EnvironmentContext } from "../prompt/sections.js";
import { PermissionChecker, type AgentMode } from "../permissions/checker.js";
import { BashTool } from "../tools/bash.js";
import { EditFileTool } from "../tools/edit-file.js";
import { GlobTool } from "../tools/glob.js";
import { GrepTool } from "../tools/grep.js";
import { ReadFileTool } from "../tools/read-file.js";
import { ToolRegistry } from "../tools/registry.js";
import { WriteFileTool } from "../tools/write-file.js";
import { VERSION } from "../version.js";
import { Activity } from "./activity.js";
import { ChatView, type ActiveTool } from "./chat-view.js";
import { Header } from "./header.js";
import { InputBox } from "./input-box.js";
import { ProviderSelect } from "./provider-select.js";
import { StatusBar } from "./status-bar.js";

type TurnStatus = "idle" | "waiting" | "streaming" | "failed";

export interface AppProps {
  providers: readonly ProviderConfig[];
  workDir?: string;
  requestTimeoutMs?: number;
  runtimeFactory?: RuntimeFactory;
}

export interface AgentRuntime {
  provider: Provider;
  systemPrompt: string;
}

export type RuntimeFactory = (
  config: ProviderConfig,
  workDir: string,
) => Promise<AgentRuntime>;

type ProviderFactory = (config: ProviderConfig) => Promise<Provider>;
type EnvironmentDetector = (workDir: string) => Promise<EnvironmentContext>;

export async function initializeAgentRuntime(
  config: ProviderConfig,
  workDir: string,
  providerFactory: ProviderFactory = createProvider,
  environmentDetector: EnvironmentDetector = detectEnvironment,
): Promise<AgentRuntime> {
  const [provider, detectedEnvironment] = await Promise.all([
    providerFactory(config),
    environmentDetector(workDir),
  ]);
  const environment = { ...detectedEnvironment, model: config.model };

  return {
    provider,
    systemPrompt: buildSystemPrompt(environment),
  };
}

export function App({
  providers,
  workDir = process.cwd(),
  requestTimeoutMs = 120_000,
  runtimeFactory = initializeAgentRuntime,
}: AppProps) {
  const { exit } = useApp();
  const [selectedConfig, setSelectedConfig] = useState<ProviderConfig | undefined>(
    providers.length === 1 ? providers[0] : undefined,
  );
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [status, setStatus] = useState<TurnStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [exitHint, setExitHint] = useState("");
  const [mode, setMode] = useState<AgentMode>("default");
  const [inputTokens, setInputTokens] = useState<number>();
  const [outputTokens, setOutputTokens] = useState<number>();
  const [iteration, setIteration] = useState<number>();
  const [startedAt, setStartedAt] = useState(Date.now());
  const conversationRef = useRef(new Conversation());
  const runtimeRef = useRef<Promise<AgentRuntime> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastCtrlCRef = useRef(0);
  const exitHintTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = status === "waiting" || status === "streaming";

  useEffect(() => () => {
    abortRef.current?.abort();
    if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
  }, []);

  useEffect(() => {
    runtimeRef.current = selectedConfig
      ? startRuntime(runtimeFactory, selectedConfig, workDir)
      : undefined;
  }, [runtimeFactory, selectedConfig, workDir]);

  useInput((input, key) => {
    if (key.escape && busy) {
      abortRef.current?.abort();
      setExitHint("Cancelling current task...");
      return;
    }

    if (key.ctrl && input === "c") {
      if (busy) {
        abortRef.current?.abort();
        setExitHint("Cancelling current task...");
        return;
      }

      const now = Date.now();
      if (now - lastCtrlCRef.current <= 2_000) {
        exit();
        return;
      }

      lastCtrlCRef.current = now;
      setExitHint("Press Ctrl+C again within 2s to exit.");
      if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
      exitHintTimerRef.current = setTimeout(() => {
        lastCtrlCRef.current = 0;
        setExitHint("");
      }, 2_000);
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

  async function submit(rawText: string): Promise<void> {
    const config = selectedConfig;
    if (busy || !config) return;
    if (rawText.trim() === "/exit") {
      exit();
      return;
    }

    const command = rawText.trim();
    const planPath = getPlanPath(workDir);
    if (command === "/plan") {
      if (mode === "plan") return;
      const reminder = buildPlanModeReentryReminder(
        planPath,
        planFileExists(planPath),
      );
      if (reminder) conversationRef.current.addSystemReminder(reminder);
      setMessages(conversationRef.current.getMessages());
      setMode("plan");
      return;
    }
    if (command === "/do") {
      if (mode === "default") return;
      conversationRef.current.addSystemReminder(
        buildPlanModeExitReminder(planPath, planFileExists(planPath)),
      );
      setMessages(conversationRef.current.getMessages());
      setMode("default");
      return;
    }

    conversationRef.current.addUserMessage(rawText);
    setMessages(conversationRef.current.getMessages());
    setStreamingText("");
    setActiveTools([]);
    setErrorMessage("");
    setInputTokens(undefined);
    setOutputTokens(undefined);
    setIteration(undefined);
    setStatus("waiting");
    setStartedAt(Date.now());

    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    let agentFailed = false;
    try {
      const runtimePromise = runtimeRef.current
        ?? startRuntime(runtimeFactory, config, workDir);
      runtimeRef.current = runtimePromise;
      const runtime = await runtimePromise;
      const registry = createToolRegistry();
      const agent = new Agent({
        provider: runtime.provider,
        registry,
        conversation: conversationRef.current,
        systemPrompt: runtime.systemPrompt,
        workDir,
        abortSignal: controller.signal,
        permissionChecker: new PermissionChecker(mode),
      });

      for await (const event of agent.run()) {
        if (event.type === "iteration_start") {
          setIteration(event.iteration);
          setStatus("streaming");
        } else if (event.type === "stream_text") {
          setStreamingText((current) => current + event.text);
          setStatus("streaming");
        } else if (event.type === "thinking_text") {
          setStatus("streaming");
        } else if (event.type === "tool_use") {
          setActiveTools((current) => [...current, {
            toolId: event.toolId,
            toolName: event.toolName,
            args: event.args,
          }]);
          setStatus("streaming");
        } else if (event.type === "tool_result") {
          setActiveTools((current) => current.filter((tool) => tool.toolId !== event.toolId));
          setMessages(conversationRef.current.getMessages());
        } else if (event.type === "turn_complete") {
          setMessages(conversationRef.current.getMessages());
          setStreamingText("");
        } else if (event.type === "usage") {
          if (event.inputTokens !== undefined) {
            setInputTokens((current) => (current ?? 0) + event.inputTokens!);
          }
          if (event.outputTokens !== undefined) {
            setOutputTokens((current) => (current ?? 0) + event.outputTokens!);
          }
        } else if (event.type === "error") {
          agentFailed = true;
          setErrorMessage(event.message);
          setStatus("failed");
        }
      }
      setMessages(conversationRef.current.getMessages());
      setStatus(controller.signal.aborted || !agentFailed ? "idle" : "failed");
    } catch (error) {
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
      setActiveTools([]);
      setIteration(undefined);
      setExitHint("");
    }
  }

  return (
    <Box flexDirection="column">
      <Header version={VERSION} model={selectedConfig.model} workDir={workDir} />
      <ChatView messages={messages} streamingText={streamingText} activeTools={activeTools} />
      <Activity
        active={busy}
        label={status === "waiting" ? "Waiting" : iteration === undefined ? "Thinking" : `Iteration ${iteration}`}
        startedAt={startedAt}
      />
      {errorMessage && <Text color="red">Error: {errorMessage}</Text>}
      {exitHint && <Text color="yellow">{exitHint}</Text>}
      <Box marginTop={1} flexDirection="column">
        <InputBox disabled={busy} onSubmit={(value) => void submit(value)} />
        <StatusBar
          mode={mode}
          {...(inputTokens === undefined ? {} : { inputTokens })}
          {...(outputTokens === undefined ? {} : { outputTokens })}
        />
      </Box>
    </Box>
  );
}

function startRuntime(
  runtimeFactory: RuntimeFactory,
  config: ProviderConfig,
  workDir: string,
): Promise<AgentRuntime> {
  const runtime = runtimeFactory(config, workDir);
  void runtime.catch(() => {});
  return runtime;
}

function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  return registry;
}
