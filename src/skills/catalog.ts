import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { load as parseYaml } from "js-yaml";
import type { ForkContext, Skill, SkillMeta, SkillMode } from "./skill.js";

const SKILLS_DIRECTORY = ".QiCode";
const SKILL_FILE = "SKILL.md";
const SKILL_FILE_PATTERN = /\.md$/i;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/i;

interface CatalogEntry {
  skill: Skill;
  loadedMtimeMs: number;
}

interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools?: string[];
  mode: SkillMode;
  forkContext: ForkContext;
  model?: string;
}

/** 扫描用户级和项目级 Skill，并提供同名覆盖与 mtime 热重载。 */
export class SkillCatalog {
  readonly #entries = new Map<string, CatalogEntry>();

  load(workDir: string): void {
    const nextEntries = new Map<string, CatalogEntry>();
    const roots = [
      join(homedir(), SKILLS_DIRECTORY, "skills"),
      join(workDir, SKILLS_DIRECTORY, "skills"),
    ];

    for (const root of roots) this.scanDirectory(root, nextEntries);

    this.#entries.clear();
    for (const [name, entry] of nextEntries) this.#entries.set(name, entry);
  }

  get(name: string): Skill | undefined {
    const key = normalizeName(name);
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;

    try {
      const mtimeMs = statSync(entry.skill.filePath).mtimeMs;
      if (mtimeMs !== entry.loadedMtimeMs) {
        const updated = loadSkill(entry.skill.filePath, entry.skill.sourceDir, entry.skill.isDirectory);
        // 名称是 Catalog 的索引键。文件若改名，等下一次完整 load() 重新建立索引；
        // 不能让旧 key 指向一个新名字的 Skill。
        if (updated !== null && updated.skill.meta.name === key) {
          entry.skill = updated.skill;
          entry.loadedMtimeMs = updated.loadedMtimeMs;
        }
      }
    } catch {
      // 磁盘短暂不可读时保留最后一次有效版本。
    }

    return entry.skill;
  }

  list(): Skill[] {
    return [...this.#entries.values()]
      .sort((left, right) => left.skill.meta.name.localeCompare(right.skill.meta.name))
      .map((entry) => entry.skill);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  private scanDirectory(
    directory: string,
    entries: Map<string, CatalogEntry>,
  ): void {
    let children: Dirent[];
    try {
      children = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }

    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const fullPath = join(directory, child.name);

      try {
        if (child.isDirectory()) {
          const skillPath = join(fullPath, SKILL_FILE);
          if (!isRegularFile(skillPath)) continue;
          const entry = loadSkill(skillPath, fullPath, true);
          if (entry !== null) entries.set(entry.skill.meta.name, entry);
          continue;
        }

        if (child.isFile() && SKILL_FILE_PATTERN.test(child.name) && child.name !== SKILL_FILE) {
          const entry = loadSkill(fullPath, dirname(fullPath), false);
          if (entry !== null) entries.set(entry.skill.meta.name, entry);
        }
      } catch {
        // 单个损坏或消失的条目不能阻断其它 Skill 加载。
      }
    }
  }
}

export function parseSkillFile(content: string): {
  meta: SkillMeta;
  body: string;
} | null {
  const opening = content.match(/^---\r?\n/);
  if (opening === null) return null;

  const closing = /\r?\n---(?:\r?\n|$)/.exec(content.slice(opening[0].length));
  if (closing === null || closing.index === undefined) return null;

  const header = content.slice(opening[0].length, opening[0].length + closing.index);
  const bodyStart = opening[0].length + closing.index + closing[0].length;

  let raw: unknown;
  try {
    raw = parseYaml(header);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const name = stringValue(raw.name);
  if (name === undefined || !SKILL_NAME_PATTERN.test(name)) return null;

  const description = stringValue(raw.description) ?? "";
  const allowedTools = parseAllowedTools(raw.allowed_tools);
  if (raw.allowed_tools !== undefined && allowedTools === null) return null;

  const mode = parseMode(raw.mode);
  if (raw.mode !== undefined && mode === null) return null;

  const forkContext = parseForkContext(raw.fork_context);
  if (raw.fork_context !== undefined && forkContext === null) return null;

  const model = raw.model === undefined ? undefined : stringValue(raw.model);
  if (raw.model !== undefined && model === undefined) return null;

  const meta: SkillMeta = {
    name: normalizeName(name),
    description,
    mode: mode ?? "inline",
    forkContext: forkContext ?? "none",
    ...(allowedTools === undefined ? {} : { allowedTools: allowedTools as string[] }),
    ...(model === undefined ? {} : { model }),
  };

  return { meta, body: content.slice(bodyStart).trim() };
}

function loadSkill(
  filePath: string,
  sourceDir: string,
  isDirectory: boolean,
): CatalogEntry | null {
  try {
    if (!isRegularFile(filePath)) return null;
    const parsed = parseSkillFile(readFileSync(filePath, "utf8"));
    if (parsed === null) return null;
    return {
      skill: { ...parsed, filePath, sourceDir, isDirectory },
      loadedMtimeMs: statSync(filePath).mtimeMs,
    };
  } catch {
    return null;
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseAllowedTools(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const tools = value.map((item) => stringValue(item));
  if (tools.some((tool) => tool === undefined)) return null;
  return [...new Set(tools as string[])];
}

function parseMode(value: unknown): SkillMode | null | undefined {
  if (value === undefined) return undefined;
  return value === "inline" || value === "fork" ? value : null;
}

function parseForkContext(value: unknown): ForkContext | null | undefined {
  if (value === undefined) return undefined;
  return value === "none" || value === "recent" || value === "full" ? value : null;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
