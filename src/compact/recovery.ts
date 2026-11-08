const RECOVERY_FILE_LIMIT = 5;
const RECOVERY_TOKENS_PER_FILE = 300;
const RECOVERY_SKILLS_BUDGET = 1_000;
const RECOVERY_TOKENS_PER_SKILL = 500;
const RECOVERY_CHARS_PER_TOKEN = 3.5;

export interface FileReadRecord {
  path: string;
  content: string;
  timestamp: number;
  evidence?: { version: string; startLine: number; endLine: number; totalLines: number };
}

export interface SkillInvocationRecord {
  name: string;
  body: string;
  timestamp: number;
}

export class RecoveryState {
  readonly #files = new Map<string, FileReadRecord>();
  readonly #skills = new Map<string, SkillInvocationRecord>();

  recordFileRead(path: string, content: string, evidence?: FileReadRecord["evidence"]): void {
    this.#files.delete(path);
    this.#files.set(path, { path, content, timestamp: Date.now(), ...(evidence ? { evidence: { ...evidence } } : {}) });
  }

  recordSkillInvocation(name: string, body: string): void {
    this.#skills.delete(name);
    this.#skills.set(name, { name, body, timestamp: Date.now() });
  }

  snapshotFiles(limit = RECOVERY_FILE_LIMIT): FileReadRecord[] {
    return [...this.#files.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, Math.max(0, limit));
  }

  snapshotSkills(): SkillInvocationRecord[] {
    return [...this.#skills.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  buildRecoveryAttachment(toolSchemaNames: readonly string[], tokenBudget = 4_000): string {
    if (tokenBudget <= 0) return "";
    const sections: string[] = [];
    const files = this.snapshotFiles();
    if (files.length > 0) sections.push(buildFilesSection(files));

    const skills = buildSkillsSection(this.snapshotSkills());
    if (skills !== "") sections.push(skills);

    if (toolSchemaNames.length > 0) {
      sections.push(
        "## Available tools\n\nYou still have access to the following tools:\n\n"
        + toolSchemaNames.map((name) => `- ${name}`).join("\n"),
      );
    }

    if (sections.length === 0) return "";
    const attachment = `${sections.join("\n\n")}\n\n## Note\nThese are bounded snapshots of observed tool results, not complete or current source files. Re-open the relevant lines when needed.`;
    const limit = Math.floor(tokenBudget * RECOVERY_CHARS_PER_TOKEN);
    const note = "\n[Recovery preview shortened; re-open relevant files.]";
    return attachment.length <= limit ? attachment : attachment.slice(0, Math.max(0, limit - note.length)) + note.slice(0, limit);
  }
}

function buildFilesSection(files: readonly FileReadRecord[]): string {
  const entries = files.map((file) => {
    const content = truncateByTokens(file.content, RECOVERY_TOKENS_PER_FILE);
    const timestamp = new Date(file.timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
    const newline = content.endsWith("\n") ? "" : "\n";
    return `### ${file.path} (read ${timestamp})${file.evidence ? `\nObserved lines: ${file.evidence.startLine}-${file.evidence.endLine}/${file.evidence.totalLines}; version: ${file.evidence.version}` : ""}\n\n\`\`\`\n${content}${newline}\`\`\``;
  });
  return "## Recently read files\n\nThese are snapshots from earlier reads. Re-open a file when current bytes are needed.\n\n"
    + entries.join("\n\n");
}

function buildSkillsSection(skills: readonly SkillInvocationRecord[]): string {
  const entries: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const body = truncateByTokens(skill.body, RECOVERY_TOKENS_PER_SKILL);
    const tokens = approxTokens(skill.name) + approxTokens(body) + 8;
    if (used + tokens > RECOVERY_SKILLS_BUDGET) break;
    used += tokens;
    entries.push(`### ${skill.name}\n\n${body}`);
  }
  return entries.length === 0 ? "" : `## Active skills\n\n${entries.join("\n\n")}`;
}

export function approxTokens(value: string): number {
  return value === "" ? 0 : Math.floor(value.length / RECOVERY_CHARS_PER_TOKEN);
}

export function truncateByTokens(value: string, tokenBudget: number): string {
  if (value === "" || tokenBudget <= 0 || approxTokens(value) <= tokenBudget) return value;
  const maxChars = Math.floor(tokenBudget * RECOVERY_CHARS_PER_TOKEN);
  if (maxChars <= 0 || maxChars >= value.length) return value;
  return `${value.slice(0, maxChars)}\n... (content truncated)`;
}
