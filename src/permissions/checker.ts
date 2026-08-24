import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { dump, load } from "js-yaml";
import { getPlanPath } from "../prompt/plan-mode.js";
import type { ToolCategory } from "../tools/types.js";

export type DecisionEffect = "allow" | "deny" | "ask";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

/** 第 04 章两档模式别名，现在等价于 PermissionMode，避免破坏既有 TUI 状态。 */
export type AgentMode = PermissionMode;

export interface Decision {
  effect: DecisionEffect;
  reason: string;
}

// 内置工具 -> 参与权限判定的「内容」字段。
// 命令执行类取命令串，读/写/改文件类取目标路径，搜索类取模式串。
const CONTENT_FIELDS: Record<string, string> = {
  Bash: "command",
  ReadFile: "file_path",
  WriteFile: "file_path",
  EditFile: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  InstallSkill: "source",
  HookCommand: "command",
  HookHttp: "url",
};

/**
 * 从工具调用参数中抽取「内容」字段：命令执行类取命令串、读/写/改取目标路径、
 * Glob/Grep 取模式串。未知工具或字段非字符串时返回空串，避免误命中规则。
 */
export function extractContent(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const field = CONTENT_FIELDS[toolName];
  if (field === undefined) return "";
  const value = args[field];
  return typeof value === "string" ? value : "";
}

/**
 * 四档权限模式 × 三类工具的兜底矩阵（规则未命中时才走到这里）。
 * 只产 allow / ask，绝不产 deny；deny 只能来自黑名单、沙箱、显式 deny 规则或人在回路拒绝。
 */
export function modeDecide(
  mode: PermissionMode,
  category: ToolCategory,
): DecisionEffect {
  switch (mode) {
    case "bypassPermissions":
      return "allow";
    case "acceptEdits":
      return category === "command" ? "ask" : "allow";
    case "plan":
      return category === "read" ? "allow" : "ask";
    case "default":
      return category === "read" ? "allow" : "ask";
  }
}

// ---- 命令安全策略：安全只读快速通道 + 危险命令硬拦截 ----

interface DangerousPattern {
  re: RegExp;
  reason: string;
}

/**
 * 危险命令黑名单（包级内置常量，不可配置、不可关闭）。
 * 启发式防御而非完备保证；任何权限模式（含 bypassPermissions）都必须先过这一层。
 */
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    re: /\brm\b[ \t]+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*[rRfF][a-zA-Z]*)[ \t]+[\/~]/,
    reason: "recursive force delete root/home",
  },
  {
    re: /\brm\b[ \t]+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*[rRfF][a-zA-Z]*)[ \t]+\*/,
    reason: "recursive force delete current directory",
  },
  { re: /\bmkfs\.\w+/, reason: "format filesystem" },
  { re: /\bdd\b[^\n]*\bif=/, reason: "write raw bytes to a device" },
  { re: />[ \t]*\/dev\/sd/, reason: "redirect output to a block device" },
  {
    re: /\bchmod\b[^\n]*-R[^\n]*777[^\n]*[ \t]+\//,
    reason: "recursively chmod root to 777",
  },
  { re: /:\(\)[ \t]*\{[ \t]*:[ \t]*\|[ \t]*:[ \t]*&[ \t]*\};:/, reason: "fork bomb" },
  {
    re: /\bcurl\b[^\n]*\|[^\n]*(?:ba)?sh\b/,
    reason: "pipe remote script into a shell",
  },
  {
    re: /\bwget\b[^\n]*\|[^\n]*(?:ba)?sh\b/,
    reason: "pipe remote script into a shell",
  },
  { re: /\bgit[ \t]+push\b[^\n]*?(?:--force\b|-f\b)/, reason: "force push" },
  { re: /\bgit[ \t]+reset\b[^\n]*--hard\b/, reason: "hard reset" },
  {
    re: /\bgit[ \t]+clean\b[^\n]*-f[a-zA-Z]*/,
    reason: "discard untracked files with git clean",
  },
  { re: /\bgit[ \t]+checkout[ \t]+\./, reason: "discard working tree changes" },
  { re: /\bgit[ \t]+branch\b[^\n]*-D\b/, reason: "force delete a branch" },
];

/**
 * 安全只读命令前缀（行为可判断为只读，不对外配置）。
 * 刻意排除 npm run / pnpm dev / python -c / node -e 等可执行任意代码的入口，
 * 也排除 git branch / git remote / git config 等带写变体的子命令（避免白名单陷阱）。
 */
const SAFE_PREFIXES: string[] = [
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "date",
  "whoami",
  "uname",
  "hostname",
  "which",
  "type",
  "file",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git rev-parse",
];

// 元字符筛查：命中任一即不允许走快速放行通道。
// & 覆盖 &&、| 覆盖 ||，比文档列举的 6 类更严、方向一致。
const UNSAFE_METACHARACTERS = [">", "|", ";", "&", "$(", "`"];

/**
 * 安全只读命令快速通道：先做元字符筛查（防「cat … > /etc/shadow」这类白名单陷阱），
 * 再与安全前缀做「完全相等 / 前缀 + 空格 / 前缀 + 制表符」匹配。
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (UNSAFE_METACHARACTERS.some((token) => trimmed.includes(token))) {
    return false;
  }
  return SAFE_PREFIXES.some(
    (prefix) =>
      trimmed === prefix ||
      trimmed.startsWith(`${prefix} `) ||
      trimmed.startsWith(`${prefix}\t`),
  );
}

/** 命中危险黑名单返回可读原因，否则返回空串；与权限模式无关。 */
export function detectDangerous(command: string): string {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.re.test(command)) return pattern.reason;
  }
  return "";
}

// ---- 文件路径沙箱：限定文件类工具的目标路径范围 ----

/**
 * 把目标路径规整为真实路径：目标不存在时，沿最近存在的祖先做 realpath，
 * 再拼回叶子路径——既允许创建新文件，又维持符号链接安全边界。
 */
function realPathOf(target: string): string {
  let current = target;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    // 保留规范化绝对路径
  }
  return suffix.length === 0 ? real : join(real, ...suffix);
}

/**
 * 路径沙箱：只允许项目根与其子树内的路径。
 * 用「逻辑路径 -> 绝对路径 -> 真实路径」三层校验，阻止 ../ 穿越、前缀碰撞和符号链接逃逸。
 * check() 返回 null 表示放行，返回 Decision 表示拒绝；空路径不伪造结论。
 */
export class PathSandbox {
  readonly #projectDir: string;
  readonly #roots: string[];

  constructor(projectDir: string) {
    this.#projectDir = projectDir;
    this.#roots = [];
    this.addRoot(projectDir);
  }

  /** 追加一个允许根目录（会先解析成真实路径）。 */
  addRoot(root: string): void {
    this.#roots.push(realPathOf(root));
  }

  check(filePath: string): Decision | null {
    if (filePath.trim() === "") return null;
    const absolute = resolve(this.#projectDir, filePath);
    const real = realPathOf(absolute);
    for (const root of this.#roots) {
      const rel = relative(root, real);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return null;
      }
    }
    return {
      effect: "deny",
      reason: `Path ${filePath} is outside allowed directories`,
    };
  }
}

// ---- 规则引擎：三级 YAML 规则 + 会话/永久放行 ----

type RuleEffect = "allow" | "deny";

interface Rule {
  tool: string;
  pattern: string;
  effect: RuleEffect;
}

const RULE_RE = /^([\w*]+)\((.+)\)$/; // 工具段允许通配 *

/**
 * 受限 glob：* 不跨路径分隔符（[^/]*），? 匹配单个非分隔符字符（[^/]），整体首尾锚定。
 * 先转义正则元字符，再替换 * 与 ?；编译或匹配异常一律视为不命中。
 */
function globMatch(pattern: string, content: string): boolean {
  try {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const source = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    return new RegExp(`^${source}$`).test(content);
  } catch {
    return false;
  }
}

/**
 * 读取并解析一个规则文件，任何异常都降级为空规则集：
 * 文件不存在/读取失败、YAML 解析失败、顶层非数组、effect 非法、rule 格式不合法——全部静默跳过，绝不让评估器抛错。
 */
function loadRulesFile(path: string): Rule[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rules: Rule[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const effect = record["effect"];
    if (effect !== "allow" && effect !== "deny") continue;
    const ruleText = record["rule"];
    if (typeof ruleText !== "string") continue;
    const match = RULE_RE.exec(ruleText);
    if (match === null) continue;
    rules.push({ tool: match[1]!, pattern: match[2]!, effect });
  }
  return rules;
}

/**
 * 三级规则引擎：用户级 -> 项目级 -> 本地级，先命中即返回。
 * 每级文件内按书写顺序「末条优先」（倒序遍历取第一个命中）。
 * 每次评估现读现匹配，因此「永久允许」写盘后立即生效、无需重启。
 */
export class RuleEngine {
  readonly #userPath: string;
  readonly #projectPath: string;
  readonly #localPath: string;

  constructor(workDir: string, homeDir = homedir()) {
    this.#userPath = join(homeDir, ".qicode", "permissions.yaml");
    this.#projectPath = join(workDir, ".qicode", "permissions.yaml");
    this.#localPath = join(workDir, ".qicode", "permissions.local.yaml");
  }

  evaluate(toolName: string, content: string): RuleEffect | null {
    for (const path of [this.#userPath, this.#projectPath, this.#localPath]) {
      const rules = loadRulesFile(path);
      for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index]!;
        if (
          (rule.tool === toolName || rule.tool === "*") &&
          globMatch(rule.pattern, content)
        ) {
          return rule.effect;
        }
      }
    }
    return null;
  }

  /** 把规则追加写入本地级配置文件（.qicode/permissions.local.yaml），不自动泛化。 */
  appendLocalRule(rule: Rule): void {
    mkdirSync(dirname(this.#localPath), { recursive: true });
    const rules = loadRulesFile(this.#localPath);
    rules.push(rule);
    const entries = rules.map((entry) => ({
      rule: `${entry.tool}(${entry.pattern})`,
      effect: entry.effect,
    }));
    writeFileSync(this.#localPath, dump(entries), "utf8");
  }
}
export class PermissionChecker {
  readonly mode: PermissionMode;
  planFilePath = "";
  readonly #sandbox: PathSandbox;
  readonly #ruleEngine: RuleEngine;
  readonly #workDir: string;
  readonly #sessionAllowed = new Set<string>();

  constructor(workDir: string, mode: PermissionMode = "default") {
    this.#workDir = workDir;
    this.mode = mode;
    this.#sandbox = new PathSandbox(workDir);
    this.#ruleEngine = new RuleEngine(workDir);
  }

  /** 会话级临时放行：进程内白名单，写入即生效，进程退出即失效，不落盘。 */
  allowForSession(toolName: string, args: Record<string, unknown>): void {
    this.#sessionAllowed.add(`${toolName}:${extractContent(toolName, args)}`);
  }

  /** 永久放行：把「工具(具体内容前60字*)」精确规则写入本地级 YAML，跨重启生效、不自动泛化。 */
  allowAlways(toolName: string, args: Record<string, unknown>): void {
    const content = extractContent(toolName, args);
    const pattern =
      content.length > 60 ? `${content.slice(0, 60)}*` : `${content}*`;
    this.#ruleEngine.appendLocalRule({ tool: toolName, pattern, effect: "allow" });
  }

  /**
   * 唯一权限入口：按 Layer 0/2/3/4/4b/5/6 顺序短路返回 Allow/Deny/Ask。
   * 调用方（Agent）应在 executor.submit 之前调用；未注册工具按 command 类处理，不会默认 Allow。
   */
  check(
    toolName: string,
    category: ToolCategory,
    args: Record<string, unknown>,
  ): Decision {
    const content = extractContent(toolName, args);

    // Layer 0: plan 模式下对计划文件的写入豁免（复用 getPlanPath，对齐第四章语义）。
    if (
      this.mode === "plan" &&
      (toolName === "WriteFile" || toolName === "EditFile") &&
      this.#isPlanFilePath(String(args.file_path ?? ""))
    ) {
      return { effect: "allow", reason: "Plan file write allowed in plan mode" };
    }

    // Layer 2: 安全只读命令快速放行（先元字符筛查，防白名单陷阱）。
    if (category === "command" && isSafeCommand(content)) {
      return { effect: "allow", reason: "Safe read-only command" };
    }

    // Layer 3: 危险命令黑名单（任何模式、任何规则都拦得住）。
    if (category === "command") {
      const dangerReason = detectDangerous(content);
      if (dangerReason !== "") {
        return {
          effect: "deny",
          reason: `Dangerous command blocked: ${dangerReason}`,
        };
      }
    }

    // Layer 4: 路径沙箱（仅文件类工具；路径参数为空时跳过，交后续层）。
    const filePath = String(args.file_path ?? args.path ?? "");
    if ((category === "read" || category === "write") && filePath !== "") {
      const sandboxDecision = this.#sandbox.check(filePath);
      if (sandboxDecision !== null) return sandboxDecision;
    }

    // Layer 4b: 会话级临时放行（进程内白名单）。
    if (this.#sessionAllowed.has(`${toolName}:${content}`)) {
      return { effect: "allow", reason: "Session allow: previously approved" };
    }

    // Layer 5: 三级规则引擎（用户级 -> 项目级 -> 本地级，文件内末条优先）。
    const ruleEffect = this.#ruleEngine.evaluate(toolName, content);
    if (ruleEffect !== null) {
      return { effect: ruleEffect, reason: `Permission rule: ${ruleEffect}` };
    }

    // Layer 6: 模式矩阵兜底（只产 allow/ask，绝不产 deny）。
    return { effect: modeDecide(this.mode, category), reason: `Mode: ${this.mode}` };
  }

  /** 目标路径是否就是第四章约定计划文件（.QiCode/plan.md）的规范化绝对路径。 */
  #isPlanFilePath(filePath: string): boolean {
    if (filePath === "") return false;
    const target = resolve(this.#workDir, filePath);
    const plan = resolve(this.#workDir, getPlanPath(this.#workDir));
    return process.platform === "win32"
      ? target.toLowerCase() === plan.toLowerCase()
      : target === plan;
  }
  /**
   * 第 04 章兼容入口：保留两档时代的布尔语义，避免 Agent 在核心流水线接入前断裂。
   * - default：全放行（旧行为；ask 尚未接入，HITL 落地前不能拦写/命令）
   * - plan：只读（保持 Plan Mode 纯只读）
   * - acceptEdits：读/写放行、命令不放行（命令在矩阵中为 ask）
   * - bypassPermissions：全放行
   * 后续第 5/6 次开发会用 check() 返回 Allow/Deny/Ask 三态替换本入口。
   */
  allows(category: ToolCategory): boolean {
    switch (this.mode) {
      case "plan":
        return category === "read";
      case "acceptEdits":
        return category !== "command";
      case "bypassPermissions":
        return true;
      case "default":
        return true;
    }
  }
}
