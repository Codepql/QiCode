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
import { lookup } from "node:dns/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { strArg } from "../tools/types.js";
import { parseSkillFile, SkillCatalog } from "./catalog.js";

const MAX_SKILL_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface SkillDownloadDependencies {
  lookup(hostname: string): Promise<readonly { address: string }[]>;
  fetch(url: URL, init: RequestInit): Promise<Response>;
}

const DEFAULT_DOWNLOAD_DEPENDENCIES: SkillDownloadDependencies = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  fetch: (url, init) => fetch(url, init),
};

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
    private readonly downloadDependencies: SkillDownloadDependencies = DEFAULT_DOWNLOAD_DEPENDENCIES,
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
      return downloadHttpsText(source, this.downloadDependencies);
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

async function downloadHttpsText(
  source: string,
  dependencies: SkillDownloadDependencies,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let url = new URL(source);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await assertPublicHttpsUrl(url, dependencies);
      const response = await dependencies.fetch(url, {
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect response did not include a location");
        if (redirects === MAX_REDIRECTS) throw new Error("too many redirects");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`remote server returned HTTP ${response.status}`);
      return readResponseText(response);
    }
    throw new Error("too many redirects");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("download timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertPublicHttpsUrl(
  url: URL,
  dependencies: SkillDownloadDependencies,
): Promise<void> {
  if (url.protocol !== "https:") throw new Error("only HTTPS URLs are allowed");
  if (url.username !== "" || url.password !== "") throw new Error("URL credentials are not allowed");

  const addresses = await dependencies.lookup(url.hostname);
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("remote URL must resolve to public addresses");
  }
}

async function readResponseText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_SKILL_BYTES) {
    throw new Error("remote Skill exceeds the size limit");
  }
  if (!response.body) throw new Error("remote response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SKILL_BYTES) throw new Error("remote Skill exceeds the size limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(concatChunks(chunks, size));
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

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  const words = ipv6Words(address);
  if (words === null) return false;

  // IPv4-mapped IPv6. Translate it back before applying the IPv4 policy.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicIpv4(`${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`);
  }

  // Internet-routable unicast currently lives in 2000::/3. A conservative
  // allowlist also rejects loopback, link-local, unique-local and multicast.
  const first = words[0]!;
  if (first < 0x2000 || first > 0x3fff) return false;
  // 2001:db8::/32 is documentation-only and must not be fetched.
  if (first === 0x2001 && words[1] === 0x0db8) return false;
  return true;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];
  const third = parts[2];
  if (first === undefined || second === undefined || third === undefined) return false;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase().split("%", 1)[0]!;

  const ipv4Match = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match !== null) {
    const octets = ipv4Match[2]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return null;
    normalized = `${ipv4Match[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}
