import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { Agent } from "../agent/agent.js";
import { forceCompact } from "../compact/compact.js";
import { RecoveryState } from "../compact/recovery.js";
import type { MCPServerConfig, ProviderConfig } from "../config/types.js";
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
import { PermissionChecker, type PermissionMode } from "../permissions/checker.js";
import { saveCompactBoundary } from "../session/session.js";
import { MCPManager } from "../mcp/manager.js";
import { MCPToolWrapper } from "../mcp/tool-wrapper.js";
import { BashTool } from "../tools/bash.js";
import { EditFileTool } from "../tools/edit-file.js";
import { GlobTool } from "../tools/glob.js";
import { GrepTool } from "../tools/grep.js";
import { ReadFileTool } from "../tools/read-file.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolSearchTool } from "../tools/tool-search.js";
import { WriteFileTool } from "../tools/write-file.js";
import { VERSION } from "../version.js";
import { Activity } from "./activity.js";
import { ChatView, type ActiveTool } from "./chat-view.js";
import { Header } from "./header.js";
import { InputBox } from "./input-box.js";
import { PermissionDialog, type PermissionAction } from "./permission-dialog.js";
import { ProviderSelect } from "./provider-select.js";
import { StatusBar } from "./status-bar.js";
import { formatArgs } from "./tool-display.js";

type TurnStatus = "idle" | "waiting" | "streaming" | "failed";

export interface AppProps {
  providers: readonly ProviderConfig[];
  mcpServers?: readonly MCPServerConfig[];
  workDir?: string;
  requestTimeoutMs?: number;
  runtimeFactory?: RuntimeFactory;
  mcpManagerFactory?: () => MCPManager;
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
const createMcpManager = (): MCPManager => new MCPManager();
const createSessionId = (): string => `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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
  mcpServers = [],
  workDir = process.cwd(),
  requestTimeoutMs = 120_000,
  runtimeFactory = initializeAgentRuntime,
  mcpManagerFactory = createMcpManager,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [selectedConfig, setSelectedConfig] = useState<ProviderConfig | undefined>(
    providers.length === 1 ? providers[0] : undefined,
  );
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [status, setStatus] = useState<TurnStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [exitHint, setExitHint] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [permissionRequest, setPermissionRequest] = useState<{
    toolName: string;
    argsSummary: string;
    reason: string;
  } | null>(null);
  const permissionResolveRef = useRef<((action: PermissionAction) => void) | null>(null);
  const [inputTokens, setInputTokens] = useState<number>();
  const [outputTokens, setOutputTokens] = useState<number>();
  const [iteration, setIteration] = useState<number>();
  const [startedAt, setStartedAt] = useState(Date.now());
  const conversationRef = useRef(new Conversation());
  const recoveryStateRef = useRef(new RecoveryState());
  const sessionIdRef = useRef(createSessionId());
  const registryRef = useRef<ToolRegistry | null>(null);
  const mcpManagerRef = useRef<MCPManager | null>(null);
  const mcpManagerFactoryRef = useRef(mcpManagerFactory);
  mcpManagerFactoryRef.current = mcpManagerFactory;
  const runtimeRef = useRef<Promise<AgentRuntime> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastCtrlCRef = useRef(0);
  const exitHintTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mcpInfo, setMcpInfo] = useState<{
    servers: string[];
    toolCount: number;
    failedServerCount: number;
  }>({ servers: [], toolCount: 0, failedServerCount: 0 });
  const mcpInfoRef = useRef(mcpInfo);
  const [mcpNotice, setMcpNotice] = useState("");
  const [compactNotice, setCompactNotice] = useState("");
  if (registryRef.current === null) registryRef.current = createToolRegistry();
  const busy = status === "waiting" || status === "streaming";
  const chatChromeRows =
    8 +
    (errorMessage !== "" ? 1 : 0) +
    (compactNotice !== "" ? 1 : 0) +
    (exitHint !== "" ? 1 : 0) +
    (permissionRequest !== null ? 8 : 0);
  const chatMaxHeight = Math.max(4, (stdout.rows ?? 24) - chatChromeRows);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
  }, []);

  useEffect(() => {
    if (mcpServers.length === 0) return;

    const manager = mcpManagerFactoryRef.current();
    mcpManagerRef.current = manager;
    let disposed = false;
    void manager.connectAll(mcpServers).then((result) => {
      if (disposed || mcpManagerRef.current !== manager) return;

      const registry = registryRef.current!;
      for (const { serverName, tool } of result.tools) {
        const client = manager.getClient(serverName);
        if (client !== undefined) {
          registry.register(new MCPToolWrapper(client, serverName, tool));
        }
      }
      for (const instruction of result.instructions) {
        conversationRef.current.addSystemReminder(
          `# MCP Server: ${instruction.serverName}\n${instruction.text}`,
        );
      }
      if (result.errors.length > 0) {
        setMcpNotice(
          `MCP errors: ${result.errors.map((entry) => `${entry.serverName}: ${sanitizeMcpError(entry.error)}`).join("; ")}`,
        );
      }
      if (result.instructions.length > 0) setMessages(conversationRef.current.getMessages());
      const info = {
        servers: result.servers,
        toolCount: result.tools.length,
        failedServerCount: result.errors.length,
      };
      mcpInfoRef.current = info;
      setMcpInfo(info);
    });

    return () => {
      disposed = true;
      if (mcpManagerRef.current === manager) mcpManagerRef.current = null;
      void manager.disconnectAll();
    };
  // MCP configuration is fixed for the lifetime of one terminal session.
  // Depending on the array prop would reconnect whenever a parent recreates it.
  }, []);

  useEffect(() => {
    runtimeRef.current = selectedConfig
      ? startRuntime(runtimeFactory, selectedConfig, workDir)
      : undefined;
  }, [runtimeFactory, selectedConfig, workDir]);

  // Shift+Tab 循环切换权限模式（原始 \x1b[Z 序列；只在此处监听，避免双重触发切两档）。
  useEffect(() => {
    const cycle: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
    const handler = (data: Buffer): void => {
      if (data.toString() === "\x1b[Z") {
        setMode((previous) => {
          const index = cycle.indexOf(previous);
          return cycle[(index + 1) % cycle.length]!;
        });
      }
    };
    process.stdin.on("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, []);

  useInput((input, key) => {
    if (key.escape && busy && permissionRequest === null) {
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
    if (command === "/mcp") {
      const currentMcpInfo = mcpInfoRef.current;
      setMcpNotice(currentMcpInfo.servers.length === 0
        ? "No MCP servers connected."
        : `MCP servers (${currentMcpInfo.servers.length}): ${currentMcpInfo.servers.join(", ")}\nTools: ${currentMcpInfo.toolCount} total`);
      return;
    }
    if (command === "/compact" || command === "/c") {
      if (busy) return;
      setCompactNotice("");
      try {
        const runtimePromise = runtimeRef.current
          ?? startRuntime(runtimeFactory, config, workDir);
        runtimeRef.current = runtimePromise;
        const runtime = await runtimePromise;
        const result = await forceCompact(
          conversationRef.current,
          runtime.provider,
          recoveryStateRef.current,
          registryRef.current!.listTools().map((tool) => tool.name),
        );
        if (result.boundary !== undefined) {
          saveCompactBoundary(workDir, sessionIdRef.current, result.boundary);
        }
        setMessages(conversationRef.current.getMessages());
        setCompactNotice(result.message);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCompactNotice(`Compaction failed: ${message}`);
      }
      return;
    }
    if (command.startsWith("/permission")) {
      const modes: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
      const parts = command.slice("/permission".length).trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "mode" && parts[1] !== undefined && (modes as string[]).includes(parts[1])) {
        setMode(parts[1] as PermissionMode);
        conversationRef.current.addSystemReminder(`Permission mode \u2192 ${parts[1]}`);
      } else if (parts[0] === "mode" && parts[1] !== undefined) {
        conversationRef.current.addSystemReminder(
          `Unknown mode '${parts[1]}'. Valid: ${modes.join(", ")}`,
        );
      } else {
        conversationRef.current.addSystemReminder(
          `Permission mode: ${mode}\nChange with shift+tab, or /permission mode <${modes.join("|")}>`,
        );
      }
      setMessages(conversationRef.current.getMessages());
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
      const registry = registryRef.current!;
      const agent = new Agent({
        provider: runtime.provider,
        registry,
        conversation: conversationRef.current,
        systemPrompt: runtime.systemPrompt,
        workDir,
        abortSignal: controller.signal,
        checker: new PermissionChecker(workDir, mode),
        recoveryState: recoveryStateRef.current,
        contextWindow: contextWindowFor(config),
        maxOutput: 8_192,
        onPermissionRequest: async (toolName, args, decision) => {
          return new Promise<PermissionAction>((resolve) => {
            let settled = false;
            const onAbort = (): void => finish("deny");
            const finish = (action: PermissionAction): void => {
              if (settled) return;
              settled = true;
              controller.signal.removeEventListener("abort", onAbort);
              if (permissionResolveRef.current === finish) {
                permissionResolveRef.current = null;
                setPermissionRequest(null);
              }
              resolve(action);
            };

            controller.signal.addEventListener("abort", onAbort, { once: true });
            permissionResolveRef.current = finish;
            setPermissionRequest({
              toolName,
              argsSummary: formatArgs(args),
              reason: decision.reason,
            });
          });
        },
      });

      for await (const event of agent.run()) {
        if (event.type === "iteration_start") {
          setIteration(event.iteration);
          setStatus("streaming");
        } else if (event.type === "compact") {
          if (event.boundary !== undefined) {
            saveCompactBoundary(workDir, sessionIdRef.current, event.boundary);
          }
          setMessages(conversationRef.current.getMessages());
          setCompactNotice(event.message);
        } else if (event.type === "stream_text") {
          setStreamingText((current) => current + event.text);
          setStatus("streaming");
        } else if (event.type === "thinking_text") {
          setStatus("streaming");
        } else if (event.type === "tool_use") {
          setStreamingText("");
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
      <ChatView messages={messages} streamingText={streamingText} activeTools={activeTools} maxHeight={chatMaxHeight} />
      <Activity
        active={busy}
        label={status === "waiting" ? "Waiting" : iteration === undefined ? "Thinking" : `Iteration ${iteration}`}
        startedAt={startedAt}
      />
      {errorMessage && <Text color="red">Error: {errorMessage}</Text>}
      {compactNotice && <Text color="cyan">{compactNotice}</Text>}
      {mcpNotice && <Text color="yellow">{mcpNotice}</Text>}
      {exitHint && <Text color="yellow">{exitHint}</Text>}
      {permissionRequest && (
        <PermissionDialog
          toolName={permissionRequest.toolName}
          argsSummary={permissionRequest.argsSummary}
          reason={permissionRequest.reason}
          onComplete={(action) => {
            permissionResolveRef.current?.(action);
            permissionResolveRef.current = null;
            setPermissionRequest(null);
          }}
        />
      )}
      <Box marginTop={1} flexDirection="column">
        <InputBox
          disabled={busy || permissionRequest !== null}
          onSubmit={(value) => void submit(value)}
        />
        <StatusBar
          mode={mode}
          {...(inputTokens === undefined ? {} : { inputTokens })}
          {...(outputTokens === undefined ? {} : { outputTokens })}
        />
      </Box>
    </Box>
  );
}

function sanitizeMcpError(message: string): string {
  return message
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
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
  registry.register(new ToolSearchTool(registry));
  return registry;
}

function contextWindowFor(config: ProviderConfig): number {
  return config.protocol === "anthropic" ? 200_000 : 128_000;
}
