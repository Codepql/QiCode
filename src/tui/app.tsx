import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { Agent } from "../agent/agent.js";
import { forceCompact } from "../compact/compact.js";
import { RecoveryState } from "../compact/recovery.js";
import {
  createDefaultRegistry,
  parseCommand,
  type CommandRegistry,
} from "../commands/commands.js";
import { loadUserCommands } from "../commands/loader.js";
import { CommandUsageTracker } from "../commands/usage-tracker.js";
import type { MCPServerConfig, ProviderConfig } from "../config/types.js";
import { Conversation } from "../conversation/conversation.js";
import type { ConversationMessage } from "../conversation/types.js";
import { createProvider, formatProviderError, type Provider } from "../llm/client.js";
import { loadInstructions } from "../memory/instructions.js";
import { MemoryManager } from "../memory/manager.js";
import { MemoryExtractor } from "../memory/extractor.js";
import { FileHistory } from "../filehistory/filehistory.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import {
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
  getPlanPath,
  planFileExists,
} from "../prompt/plan-mode.js";
import type { EnvironmentContext } from "../prompt/sections.js";
import { PermissionChecker, type PermissionMode } from "../permissions/checker.js";
import {
  listSessions,
  loadSession,
  newSessionId,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
  cleanExpiredSessions,
} from "../session/session.js";
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
  const sessionIdRef = useRef(newSessionId());
  const mcpInstructionsRef = useRef<string[]>([]);
  const memoryExtractorRef = useRef<MemoryExtractor | null>(null);
  const memoryCursorRef = useRef(0);
  const memoryExtractingRef = useRef(false);
  const fileHistoryRef = useRef<FileHistory | null>(null);
  const registryRef = useRef<ToolRegistry | null>(null);
  const commandRegistryRef = useRef<CommandRegistry | null>(null);
  const commandUsageTrackerRef = useRef<CommandUsageTracker | null>(null);
  const commandDiagnosticsRef = useRef<string[]>([]);
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
  if (commandRegistryRef.current === null) {
    const commandRegistry = createDefaultRegistry();
    for (const command of loadUserCommands(workDir)) {
      if (commandRegistry.hasConflict(command)) {
        commandDiagnosticsRef.current.push(`Skipped /${command.name}: name or alias conflicts.`);
        continue;
      }
      try {
        commandRegistry.register(command);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        commandDiagnosticsRef.current.push(`Skipped /${command.name}: ${detail}`);
      }
    }
    commandRegistryRef.current = commandRegistry;
  }
  if (commandUsageTrackerRef.current === null) {
    commandUsageTrackerRef.current = new CommandUsageTracker(workDir);
  }
  const busy = status === "waiting" || status === "streaming";
  const chatChromeRows =
    8 +
    (errorMessage !== "" ? 1 : 0) +
    (compactNotice !== "" ? 1 : 0) +
    (exitHint !== "" ? 1 : 0) +
    (permissionRequest !== null ? 8 : 0);
  const chatMaxHeight = Math.max(4, (stdout.rows ?? 24) - chatChromeRows);

  useEffect(() => {
    injectDurableContext(conversationRef.current, workDir);
    FileHistory.cleanupEmptySessionDirs(workDir);
    try {
      fileHistoryRef.current = new FileHistory(workDir, sessionIdRef.current);
    } catch {
      fileHistoryRef.current = null;
    }
    void Promise.resolve().then(() => cleanExpiredSessions(workDir)).catch(() => {});
    setMessages(conversationRef.current.getMessages());
  }, [workDir]);

  useEffect(() => {
    if (commandDiagnosticsRef.current.length > 0) {
      setCompactNotice(commandDiagnosticsRef.current.join("\n"));
    }
  }, []);

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
        mcpInstructionsRef.current.push(`# MCP Server: ${instruction.serverName}\n${instruction.text}`);
        conversationRef.current.addSystemReminder(mcpInstructionsRef.current.at(-1)!);
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

  async function handleSlashCommand(rawText: string, config: ProviderConfig): Promise<boolean> {
    const parsed = parseCommand(rawText);
    if (parsed === null) return false;

    const command = commandRegistryRef.current!.find(parsed.name);
    if (command === undefined) {
      setCompactNotice(`Unknown command: /${parsed.name}`);
      return true;
    }
    commandUsageTrackerRef.current!.record(command.name);

    if (command.name === "mcp") {
      const info = mcpInfoRef.current;
      setCompactNotice(info.servers.length === 0
        ? "No MCP servers connected."
        : `MCP servers (${info.servers.length}): ${info.servers.join(", ")}\nTools: ${info.toolCount} total`);
      return true;
    }
    if (command.name === "memory") {
      await handleMemoryCommand(parsed.args || undefined);
      return true;
    }
    if (command.name === "permission") {
      handlePermissionCommand(parsed.args);
      return true;
    }

    const context = {
      workDir,
      args: parsed.args,
      permissionMode: () => mode,
      tokenCount: () => [inputTokens ?? 0, outputTokens ?? 0] as const,
      toolCount: () => registryRef.current?.listTools().length ?? 0,
      memoryList: () => new MemoryManager(workDir).getMemories().map((memory) => memory.name),
      memoryClear: () => new MemoryManager(workDir).clear(),
      model: config.model,
    };

    if (command.type === "local") {
      setCompactNotice(command.handler(context));
      return true;
    }
    if (command.type === "prompt") {
      const prompt = command.handler(context);
      if (prompt.trim() === "") {
        setCompactNotice(`Command /${command.name} produced an empty prompt.`);
      } else {
        await submit(prompt, true);
      }
      return true;
    }

    await handleLocalUiAction(command.handler(context), parsed.args, config);
    return true;
  }

  function handlePermissionCommand(args: string): void {
    const modes: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
    const parts = args.split(/\s+/).filter(Boolean);
    if (parts[0] === "mode" && parts[1] !== undefined && (modes as string[]).includes(parts[1])) {
      setMode(parts[1] as PermissionMode);
      setCompactNotice(`Permission mode -> ${parts[1]}`);
      return;
    }
    if (parts[0] === "mode" && parts[1] !== undefined) {
      setCompactNotice(`Unknown mode '${parts[1]}'. Valid: ${modes.join(", ")}`);
      return;
    }
    setCompactNotice(
      `Permission mode: ${mode}\nChange with shift+tab, or /permission mode <${modes.join("|")}>`,
    );
  }

  async function handleLocalUiAction(
    action: string,
    args: string,
    config: ProviderConfig,
  ): Promise<void> {
    const extensionHandler = commandRegistryRef.current!.getActionHandler(action);
    if (extensionHandler !== undefined) {
      try {
        await extensionHandler(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCompactNotice(`Command action failed: ${message}`);
      }
      return;
    }

    switch (action) {
      case "clear":
        clearConversation();
        return;
      case "compact":
        await compactConversation(config);
        return;
      case "plan":
        enterPlanMode();
        return;
      case "do":
        exitPlanMode();
        return;
      case "resume":
        resumeSession(args || undefined);
        return;
      case "rewind":
        handleRewind(args === "" ? undefined : Number(args));
        return;
      case "quit":
        exit();
        return;
      default:
        setCompactNotice(`Unsupported command action: ${action}`);
    }
  }

  function clearConversation(): void {
    const conversation = new Conversation();
    injectDurableContext(conversation, workDir);
    conversationRef.current = conversation;
    recoveryStateRef.current = new RecoveryState();
    sessionIdRef.current = newSessionId();
    memoryCursorRef.current = 0;
    try {
      fileHistoryRef.current = new FileHistory(workDir, sessionIdRef.current);
    } catch {
      fileHistoryRef.current = null;
    }
    setMessages(conversation.getMessages());
    setStreamingText("");
    setActiveTools([]);
    setErrorMessage("");
    setCompactNotice("Conversation cleared.");
    setInputTokens(undefined);
    setOutputTokens(undefined);
    setIteration(undefined);
  }

  function enterPlanMode(): void {
    if (mode === "plan") return;
    const planPath = getPlanPath(workDir);
    const reminder = buildPlanModeReentryReminder(planPath, planFileExists(planPath));
    if (reminder) conversationRef.current.addSystemReminder(reminder);
    setMessages(conversationRef.current.getMessages());
    setMode("plan");
    setCompactNotice("Plan mode enabled.");
  }

  function exitPlanMode(): void {
    if (mode === "default") return;
    const planPath = getPlanPath(workDir);
    conversationRef.current.addSystemReminder(
      buildPlanModeExitReminder(planPath, planFileExists(planPath)),
    );
    setMessages(conversationRef.current.getMessages());
    setMode("default");
    setCompactNotice("Plan mode disabled.");
  }

  async function compactConversation(config: ProviderConfig): Promise<void> {
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
  }

  async function submit(rawText: string, bypassSlash = false): Promise<void> {
    const config = selectedConfig;
    if (busy || !config) return;
    if (!bypassSlash && await handleSlashCommand(rawText, config)) return;

    const checkpointMessageIndex = conversationRef.current.getMessages().length;
    conversationRef.current.addUserMessage(rawText);
    persistSessionMessage("user", rawText);
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
      if (memoryExtractorRef.current === null) {
        memoryExtractorRef.current = new MemoryExtractor(runtime.provider, workDir);
      }
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
        ...(fileHistoryRef.current === null ? {} : { fileHistory: fileHistoryRef.current }),
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
        } else if (event.type === "loop_complete") {
          if (!agentFailed && !controller.signal.aborted) {
            persistFinalAssistantMessage();
            if (fileHistoryRef.current?.hasPendingChanges()) {
              fileHistoryRef.current.makeSnapshot(checkpointMessageIndex, rawText);
            }
            triggerMemoryExtraction(runtime.provider);
          }
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

  function persistSessionMessage(role: "user" | "assistant", content: string): void {
    try {
      saveMessage(workDir, sessionIdRef.current, {
        role,
        content,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Session persistence is optional; an I/O failure must not interrupt a turn.
    }
  }

  function persistFinalAssistantMessage(): void {
    const lastMessage = conversationRef.current.getMessages().at(-1);
    if (lastMessage?.role !== "assistant") return;

    const content = Conversation.visibleText(lastMessage);
    if (content.trim() !== "") persistSessionMessage("assistant", content);
  }

  function triggerMemoryExtraction(provider: Provider): void {
    const conversation = conversationRef.current.getMessages();
    if (conversation.length - memoryCursorRef.current < 2) return;
    const cursor = conversation.length;
    const summary = conversation
      .slice(Math.max(0, conversation.length - 40))
      .map((message) => `${message.role}: ${Conversation.visibleText(message)}`)
      .filter((line) => line.length >= 12)
      .join("\n")
      .slice(-40_000);
    if (summary.trim() === "") return;

    const extractor = memoryExtractorRef.current ?? new MemoryExtractor(provider, workDir);
    memoryExtractorRef.current = extractor;
    const isPending = extractor.isRunning;
    if (!isPending) memoryExtractingRef.current = true;
    void extractor.extract(summary)
      .then((saved) => {
        if (!isPending) memoryCursorRef.current = cursor;
        if (saved.length > 0) setCompactNotice(`Memory saved: ${saved.join(", ")}`);
      })
      .catch(() => {})
      .finally(() => {
        if (!isPending) memoryExtractingRef.current = false;
      });
  }

  async function handleMemoryCommand(query: string | undefined): Promise<void> {
    const manager = new MemoryManager(workDir);
    if (query?.toLowerCase() === "clear") {
      manager.clear();
      setCompactNotice("Cleared durable memories.");
      return;
    }
    if (query === undefined || query === "") {
      const memories = manager.getMemories();
      setCompactNotice(memories.length === 0
        ? "No durable memories found."
        : [
            `Memory index: ${memories.length} entries`,
            `Project: ${manager.projectDir}`,
            `User: ${manager.userDir}`,
            ...memories.map((memory) => `- ${memory.name} (${memory.type}): ${memory.description}`),
          ].join("\n"));
      return;
    }

    const runtime = runtimeRef.current;
    if (runtime === undefined) {
      setCompactNotice("Provider is not ready for memory search.");
      return;
    }
    try {
      const selected = await manager.findRelevantMemories(query, (await runtime).provider);
      if (selected.length === 0) {
        setCompactNotice(`No relevant memories found for: ${query}`);
        return;
      }
      const selectedPaths = new Set(selected.map((memory) => memory.path));
      const entries = manager.getMemories().filter((memory) => selectedPaths.has(memory.path));
      conversationRef.current.addSystemReminder(
        `Relevant memories for "${query}":\n${entries.map((memory) => (
          `## ${memory.name}\n${memory.content.trim()}`
        )).join("\n\n")}`,
      );
      setMessages(conversationRef.current.getMessages());
      setCompactNotice(`Loaded ${entries.length} relevant memor${entries.length === 1 ? "y" : "ies"}.`);
    } catch {
      setCompactNotice("Memory search failed.");
    }
  }

  function handleRewind(snapshotIndex: number | undefined): void {
    const history = fileHistoryRef.current;
    if (history === null || !history.hasSnapshots()) {
      setCompactNotice("No checkpoints to rewind to.");
      return;
    }
    const snapshots = history.getSnapshots();
    if (snapshotIndex === undefined) {
      setCompactNotice([
        "Checkpoints (use /rewind <index> to restore):",
        ...snapshots.map((snapshot, index) => `  ${index}: ${snapshot.label}`),
      ].join("\n"));
      return;
    }
    if (!Number.isInteger(snapshotIndex) || snapshotIndex < 0 || snapshotIndex >= snapshots.length) {
      setCompactNotice(`Unknown checkpoint index: ${snapshotIndex}`);
      return;
    }
    const snapshot = snapshots[snapshotIndex]!;
    const changed = history.rewind(snapshotIndex);
    conversationRef.current.truncateTo(snapshot.messageIndex);
    setMessages(conversationRef.current.getMessages());
    setCompactNotice(`Rewound to checkpoint ${snapshotIndex}. Restored ${changed.length} file(s).`);
  }

  function resumeSession(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === "") {
      const sessions = listSessions(workDir).slice(0, 10);
      setCompactNotice(sessions.length === 0
        ? "No sessions found."
        : `Sessions (use /resume <id> to restore):\n${sessions.map((session) => (
          `  ${sessions.indexOf(session)}: ${session.id} (${session.messageCount} messages) - ${session.firstMessage}`
        )).join("\n")}`);
      return;
    }

    let targetSessionId = sessionId;
    if (/^\d+$/.test(sessionId)) {
      const index = Number(sessionId);
      const session = listSessions(workDir).at(index);
      if (session === undefined) {
        setCompactNotice(`Unknown session index: ${sessionId}`);
        return;
      }
      targetSessionId = session.id;
    }

    try {
      const saved = loadSession(workDir, targetSessionId);
      if (saved.length === 0) {
        setCompactNotice(`Session "${targetSessionId}" not found or empty.`);
        return;
      }

      const restored = rebuildFromSession(saved);
      const conversation = new Conversation();
      injectDurableContext(conversation, workDir);
      const durableContext = conversation.getMessages();
      const mcpReminders = mcpInstructionsRef.current.map((instruction) => ({
        role: "user" as const,
        content: [{
          type: "text" as const,
          text: `<system-reminder>\n${instruction}\n</system-reminder>`,
        }],
      }));
      conversation.restoreMessages(restored, [...durableContext, ...mcpReminders]);

      conversationRef.current = conversation;
      recoveryStateRef.current = new RecoveryState();
      sessionIdRef.current = targetSessionId;
      try {
        fileHistoryRef.current = new FileHistory(workDir, targetSessionId);
      } catch {
        fileHistoryRef.current = null;
      }
      setMessages(conversation.getMessages());
      setStreamingText("");
      setActiveTools([]);
      setErrorMessage("");
      setCompactNotice(`Resumed session ${targetSessionId} (${restored.length} messages).`);
    } catch {
      setCompactNotice(`Session "${sessionId}" could not be restored.`);
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
          commands={commandRegistryRef.current!.listCommands()}
          usageTracker={commandUsageTrackerRef.current!}
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

function injectDurableContext(conversation: Conversation, workDir: string): void {
  try {
    conversation.injectLongTermMemory(
      loadInstructions(workDir),
      new MemoryManager(workDir).buildSystemReminder(),
    );
  } catch {
    // Durable context is best effort and must not block normal chat startup.
  }
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
