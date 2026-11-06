export type CommandType = "local" | "local_ui" | "prompt" | "skill_fork";

export interface CommandContext {
  workDir: string;
  args: string;
  permissionMode?: () => string;
  tokenCount?: () => readonly [number, number];
  toolCount?: () => number;
  memoryList?: () => string[];
  memoryClear?: () => void;
  model?: string;
}

export interface Command {
  name: string;
  aliases: string[];
  type: CommandType;
  description: string;
  argumentHint?: string;
  handler: (context: CommandContext) => string;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

export type CommandActionHandler = (args: string) => void | Promise<void>;

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #aliases = new Map<string, string>();
  readonly #actionHandlers = new Map<string, CommandActionHandler>();

  register(command: Command): void {
    const name = normalizeName(command.name);
    const aliases = command.aliases.map(normalizeName);

    validateCommandName(name, "Command name");
    for (const alias of aliases) validateCommandName(alias, "Command alias");

    if (new Set(aliases).size !== aliases.length) {
      throw new Error(`Command '${command.name}' contains duplicate aliases`);
    }
    if (aliases.includes(name)) {
      throw new Error(`Command alias '${command.name}' collides with its command name`);
    }
    if (this.#commands.has(name)) {
      throw new Error(`Command '${command.name}' is already registered`);
    }
    if (this.#aliases.has(name)) {
      throw new Error(`Command name '${command.name}' collides with an existing alias`);
    }

    for (const alias of aliases) {
      if (this.#commands.has(alias)) {
        throw new Error(`Command alias '${alias}' collides with an existing command name`);
      }
      if (this.#aliases.has(alias)) {
        throw new Error(`Command alias '${alias}' is already registered`);
      }
    }

    const registeredCommand: Command = {
      ...command,
      name,
      aliases,
    };
    this.#commands.set(name, registeredCommand);
    for (const alias of aliases) this.#aliases.set(alias, name);
  }

  hasConflict(command: Command): boolean {
    const name = normalizeName(command.name);
    const aliases = command.aliases.map(normalizeName);

    return this.#commands.has(name)
      || this.#aliases.has(name)
      || aliases.includes(name)
      || new Set(aliases).size !== aliases.length
      || aliases.some((alias) => this.#commands.has(alias) || this.#aliases.has(alias));
  }

  find(name: string): Command | undefined {
    const normalized = normalizeName(name);
    return this.#commands.get(normalized)
      ?? this.#commands.get(this.#aliases.get(normalized) ?? "");
  }

  listCommands(): Command[] {
    return [...this.#commands.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(copyCommand);
  }

  complete(prefix: string): Command[] {
    const normalized = normalizeName(prefix);
    return this.listCommands().filter((command) =>
      command.name.startsWith(normalized)
      || command.aliases.some((alias) => alias.startsWith(normalized))
    );
  }

  registerActionHandler(action: string, handler: CommandActionHandler): void {
    const normalized = normalizeName(action);
    validateCommandName(normalized, "Command action");
    if (this.#actionHandlers.has(normalized)) {
      throw new Error(`Command action '${action}' is already registered`);
    }
    this.#actionHandlers.set(normalized, handler);
  }

  getActionHandler(action: string): CommandActionHandler | undefined {
    return this.#actionHandlers.get(normalizeName(action));
  }
}

export function registerModuleCommands(
  registry: CommandRegistry,
  commands: readonly Command[],
): string[] {
  const diagnostics: string[] = [];
  for (const command of commands) {
    if (registry.hasConflict(command)) {
      diagnostics.push(`Command /${command.name} conflicts with an existing command.`);
      continue;
    }
    try {
      registry.register(command);
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  return diagnostics;
}

export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register({
    name: "help",
    aliases: ["h", "?"],
    type: "local",
    description: "Show available commands or details for one command",
    handler: ({ args }) => {
      if (args !== "") {
        const command = registry.find(args);
        if (!command) return `Unknown command: /${args}`;
        const aliases = command.aliases.length > 0
          ? `\nAliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")}`
          : "";
        return `/${command.name} — ${command.description}${aliases}`;
      }

      const commands = registry.listCommands().map((command) => {
        const aliases = command.aliases.length > 0
          ? `, ${command.aliases.map((alias) => `/${alias}`).join(", ")}`
          : "";
        return `  /${command.name}${aliases}\n    ${command.description}`;
      });
      return `Available commands:\n\n${commands.join("\n")}`;
    },
  });
  registry.register({
    name: "clear",
    aliases: [],
    type: "local_ui",
    description: "Clear the current conversation",
    handler: () => "clear",
  });
  registry.register({
    name: "compact",
    aliases: ["c"],
    type: "local_ui",
    description: "Force context compaction",
    handler: () => "compact",
  });
  registry.register({
    name: "status",
    aliases: ["s"],
    type: "local",
    description: "Show current runtime status",
    handler: (context) => {
      const lines = ["QiCode Status"];
      const tokens = context.tokenCount?.();
      if (context.permissionMode) lines.push(`Mode: ${context.permissionMode()}`);
      if (tokens) lines.push(`Input tokens: ${tokens[0]}`);
      if (tokens) lines.push(`Output tokens: ${tokens[1]}`);
      if (context.toolCount) lines.push(`Tools: ${context.toolCount()}`);
      if (context.memoryList) lines.push(`Memories: ${context.memoryList().length}`);
      if (context.model) lines.push(`Model: ${context.model}`);
      lines.push(`Workdir: ${context.workDir}`);
      return lines.join("\n");
    },
  });
  registry.register({
    name: "session",
    aliases: [],
    type: "local",
    description: "Show the active session and resume help",
    handler: () => "Session is active. Use /resume to list past sessions.",
  });
  registry.register({
    name: "plan",
    aliases: ["p"],
    type: "local_ui",
    description: "Enter plan mode",
    handler: () => "plan",
  });
  registry.register({
    name: "do",
    aliases: [],
    type: "local_ui",
    description: "Exit plan mode and continue execution",
    handler: () => "do",
  });
  registry.register({
    name: "resume",
    aliases: ["r"],
    type: "local_ui",
    description: "List or resume a previous session",
    handler: () => "resume",
  });
  registry.register({
    name: "quit",
    aliases: ["exit", "q"],
    type: "local_ui",
    description: "Exit QiCode",
    handler: () => "quit",
  });
  registry.register({
    name: "memory",
    aliases: [],
    type: "local",
    description: "Show or clear persistent memory",
    handler: () => "memory",
  });
  registry.register({
    name: "permission",
    aliases: ["perm"],
    type: "local",
    description: "Show or change permission mode",
    handler: () => "permission",
  });
  registry.register({
    name: "review",
    aliases: [],
    type: "prompt",
    description: "Ask the agent to review uncommitted changes",
    handler: ({ args }) => {
      const prompt = "Review the current uncommitted changes. Run `git status` and `git diff` to identify bugs, security issues, and unnecessary complexity.";
      return args === "" ? prompt : `${prompt}\n\nFocus on: ${args}`;
    },
  });
  registry.register({
    name: "rewind",
    aliases: [],
    type: "local_ui",
    description: "List or restore file checkpoints",
    handler: () => "rewind",
  });
  registry.register({
    name: "mcp",
    aliases: [],
    type: "local",
    description: "Show connected MCP servers and tools",
    handler: () => "mcp",
  });
  registry.register({
    name: "skills",
    aliases: [],
    type: "local_ui",
    description: "List available Skills",
    handler: () => "skills",
  });

  for (const [name, description] of [
    ["model", "选择已配置的模型；运行中登记待切换"],
    ["new", "新建会话，保留原会话和草稿"],
    ["rename", "命名当前会话：/rename 标题"],
    ["settings", "偏好设置与按键配置"],
    ["hotkeys", "查看当前有效快捷键"],
    ["tasks", "查看任务、日志与单项取消"],
    ["files", "搜索并引用工作区文件；/files remove <序号> 移除"],
  ] as const) registry.register({ name, aliases: [], type: "local_ui", description, handler: () => name });

  return registry;
}

export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith("/")) return null;

  const trimmed = input.slice(1).trim();
  if (trimmed === "") return { name: "", args: "" };

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace === -1) return { name: trimmed, args: "" };

  return {
    name: trimmed.slice(0, firstWhitespace),
    args: trimmed.slice(firstWhitespace).trim(),
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function validateCommandName(name: string, label: string): void {
  if (name === "") throw new Error(`${label} must not be empty`);
  if (/\s/.test(name)) throw new Error(`${label} must not contain whitespace: '${name}'`);
}

function copyCommand(command: Command): Command {
  return { ...command, aliases: [...command.aliases] };
}
