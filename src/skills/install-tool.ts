import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fetchSafeText, type SafeFetchDependencies } from "../security/safe-fetch.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { strArg } from "../tools/types.js";
import { parseSkillFile, SkillCatalog } from "./catalog.js";

const MAX_SKILL_BYTES = 512 * 1024;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export type SkillDownloadDependencies = SafeFetchDependencies;
export { isPublicAddress } from "../security/safe-fetch.js";

/** 将一份经过校验的单文件 Skill 安装到当前项目。 */
export class InstallSkillTool implements Tool {
  readonly name = "InstallSkill";
  readonly description = "Install one validated Skill file from a workspace path or HTTPS URL.";
  readonly category = "command" as const;
  readonly system = true;

  constructor(
    private readonly workDir: string,
    private readonly catalog: SkillCatalog,
    private readonly onInstalled?: (name: string) => void,
    private readonly downloadDependencies?: SkillDownloadDependencies,
  ) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "A UTF-8 Skill file inside the workspace, or an HTTPS URL to one Skill file.",
          },
          name: {
            type: "string",
            description: "Optional lowercase slug used as both the installed directory and Skill name.",
          },
        },
        required: ["source"],
      },
    };
  }

  async execute(
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const source = strArg(args, "source").trim();
    if (source === "") return { output: "Error: source is required", isError: true };

    try {
      const content = await this.readSource(source);
      const requestedName = strArg(args, "name").trim().toLowerCase();
      const normalized = validateAndNameSkill(content, requestedName);
      const target = installAtomically(this.workDir, normalized.name, normalized.content);

      this.catalog.load(this.workDir);
      this.onInstalled?.(normalized.name);
      return {
        output: `Skill '${normalized.name}' installed to ${target}`,
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Skill installation failed";
      return { output: `Skill installation failed: ${message}`, isError: true };
    }
  }

  private async readSource(source: string): Promise<string> {
    if (/^https?:\/\//i.test(source)) {
      if (!source.toLowerCase().startsWith("https://")) {
        throw new Error("only HTTPS URLs are allowed");
      }
      return fetchSafeText(source, {
        timeoutMs: 15_000,
        maxResponseBytes: MAX_SKILL_BYTES,
        maxRedirects: 3,
        allowLoopback: false,
      }, this.downloadDependencies);
    }
    return readWorkspaceFile(this.workDir, source);
  }
}

function readWorkspaceFile(workDir: string, source: string): string {
  const workspace = realpathSync(workDir);
  const candidate = resolve(workspace, source);
  if (!isInside(workspace, candidate)) throw new Error("local source must stay inside the workspace");
  if (lstatSync(candidate).isSymbolicLink()) throw new Error("symbolic-link sources are not allowed");

  const realSource = realpathSync(candidate);
  if (!isInside(workspace, realSource)) throw new Error("local source resolves outside the workspace");
  if (!statSync(realSource).isFile()) throw new Error("local source must be a regular file");
  if (statSync(realSource).size > MAX_SKILL_BYTES) throw new Error("Skill file exceeds the size limit");

  const content = readFileSync(realSource, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("Skill file exceeds the size limit");
  }
  return content;
}

function validateAndNameSkill(content: string, overrideName: string): { name: string; content: string } {
  const parsed = parseSkillFile(content);
  if (parsed === null) throw new Error("source is not a valid SKILL.md file");

  const name = overrideName === "" ? parsed.meta.name : overrideName;
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new Error("Skill name must be a lowercase slug containing letters, digits, and hyphens");
  }

  const namedContent = overrideName === "" ? content : replaceFrontmatterName(content, name);
  const validated = parseSkillFile(namedContent);
  if (validated === null || validated.meta.name !== name) {
    throw new Error("Skill name override produced an invalid Skill file");
  }
  return { name, content: namedContent };
}

function installAtomically(workDir: string, name: string, content: string): string {
  const workspace = realpathSync(workDir);
  const configDir = join(workspace, ".QiCode");
  const skillRoot = join(configDir, "skills");
  ensureDirectory(configDir, workspace);
  ensureDirectory(skillRoot, workspace);

  const target = join(skillRoot, name);
  if (!isInside(skillRoot, target)) throw new Error("invalid installation target");
  if (existsSync(target)) throw new Error(`Skill '${name}' is already installed in this project`);

  const temporary = mkdtempSync(join(skillRoot, ".install-"));
  try {
    writeFileSync(join(temporary, "SKILL.md"), content, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return join(".QiCode", "skills", name, "SKILL.md");
}

function ensureDirectory(directory: string, workspace: string): void {
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory()) {
    throw new Error("Skill installation directory must not be a symbolic link");
  }
  if (!isInside(workspace, realpathSync(directory))) {
    throw new Error("Skill installation directory resolves outside the workspace");
  }
}

function replaceFrontmatterName(content: string, name: string): string {
  const opening = content.match(/^---\r?\n/);
  if (opening === null) throw new Error("source is not a valid SKILL.md file");
  const rest = content.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(rest);
  if (closing === null || closing.index === undefined) throw new Error("source is not a valid SKILL.md file");

  const header = rest.slice(0, closing.index);
  if (!/(^|\r?\n)\s*name\s*:/i.test(header)) {
    throw new Error("source Skill must declare a name");
  }
  const rewrittenHeader = header.replace(
    /(^|\r?\n)(\s*name\s*:)\s*[^\r\n]*/i,
    `$1$2 ${name}`,
  );
  return `${opening[0]}${rewrittenHeader}${rest.slice(closing.index)}`;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
