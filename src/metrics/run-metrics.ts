import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SpanKind = "request" | "tool" | "permission" | "backoff" | "compaction" | "initialization";
export type SpanStatus = "completed" | "failed" | "cancelled" | "timeout" | "ineffective" | "skipped" | "unknown";
export interface MetricFields {
  requestId?: string; attempt?: number; purpose?: "main" | "compaction" | "auxiliary"; toolName?: string; toolId?: string;
  inputEstimate?: number; beforeTokens?: number; afterTokens?: number; source?: string;
  trigger?: string; keptMessages?: number; summaryChars?: number;
  decision?: "allow" | "deny" | "allowAlways" | "allowTask";
}
export interface MetricUsage { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
export interface ReadEvidence { path: string; version: string; startLine: number; endLine: number; totalLines: number; toolId: string; kind: "new" | "repeat" | "overlap" | "changed" }
export interface RunIdentity { model: string; protocol: string; contextWindow: number; maxOutput: number; budgetSource: string; parentRunId?: string; endpointId?: string }
export type MetricEvent = {
  version: 1; runId: string; atMs: number; timestamp: string;
} & (
  | { type: "run_start"; identity: RunIdentity }
  | { type: "span_start"; spanId: string; kind: SpanKind; fields: MetricFields }
  | { type: "span_end"; spanId: string; status: SpanStatus; fields: MetricFields }
  | { type: "first_event" | "first_text"; spanId: string }
  | { type: "usage"; spanId: string; usage: MetricUsage }
  | { type: "read"; evidence: ReadEvidence }
  | { type: "run_end"; outcome: string }
);
export interface MetricSpan { id: string; kind: SpanKind; start: number; end?: number; status?: SpanStatus; fields: MetricFields; firstEvent?: number; firstText?: number; usage: MetricUsage }
export interface RunSummary {
  runId: string; identity: RunIdentity | undefined; outcome: string; elapsedMs: number | null; observedMs: number;
  activeMs: number | null; approvalMs: number; firstToolMs: number | null; requests: number; attempts: number;
  firstTextMs: number | null; compactions: { attempts: number; successful: number; failed: number; ineffective: number; skipped: number };
  tools: number; reads: ReadEvidence[]; spans: MetricSpan[]; usage: MetricUsage; usageIncomplete: boolean; warning?: string;
}
const usageKeys = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;

/** Merge cumulative usage within an attempt; output-only updates never clear input. */
function mergeUsage(target: MetricUsage, value: MetricUsage): void {
  for (const key of usageKeys) if (value[key] !== undefined && Number.isFinite(value[key]) && value[key]! >= 0) target[key] = Math.max(target[key] ?? 0, value[key]!);
}
function unionDuration(intervals: { start: number; end: number }[]): number {
  const sorted = intervals.sort((a, b) => a.start - b.start); let total = 0; let end = 0;
  for (const interval of sorted) { total += Math.max(0, interval.end - Math.max(end, interval.start)); end = Math.max(end, interval.end); }
  return total;
}
export function summarizeMetrics(events: readonly MetricEvent[], currentMs?: number): RunSummary {
  const start = events.find((event) => event.type === "run_start");
  const ending = events.findLast((event) => event.type === "run_end");
  const observedMs = Math.max(0, ending?.atMs ?? currentMs ?? events.at(-1)?.atMs ?? 0);
  const spans = new Map<string, MetricSpan>(); const reads: ReadEvidence[] = [];
  for (const event of events) {
    if (event.type === "span_start") spans.set(event.spanId, { id: event.spanId, kind: event.kind, start: event.atMs, fields: event.fields, usage: {} });
    else if (event.type === "read") reads.push(event.evidence);
    else if ("spanId" in event) {
      const span = spans.get(event.spanId); if (!span) continue;
      if (event.type === "span_end") { span.end = event.atMs; span.status = event.status; span.fields = { ...span.fields, ...event.fields }; }
      else if (event.type === "first_event") span.firstEvent ??= event.atMs;
      else if (event.type === "first_text") span.firstText ??= event.atMs;
      else if (event.type === "usage") mergeUsage(span.usage, event.usage);
    }
  }
  const all = [...spans.values()]; const attempts = all.filter((span) => span.kind === "request");
  const compactions = all.filter((span) => span.kind === "compaction"); const usage: MetricUsage = {};
  for (const key of usageKeys) { const known = attempts.filter((span) => span.usage[key] !== undefined); if (known.length) usage[key] = known.reduce((sum, span) => sum + span.usage[key]!, 0); }
  const approvalMs = unionDuration(all.filter((span) => span.kind === "permission").map((span) => ({ start: span.start, end: Math.min(observedMs, span.end ?? observedMs) })));
  const elapsedMs = ending ? observedMs : null;
  const firstTool = all.find((span) => span.kind === "tool"); const firstText = attempts.find((span) => (span.fields.purpose ?? "main") === "main" && span.firstText !== undefined);
  return { runId: start?.runId ?? events[0]?.runId ?? "unknown", identity: start?.type === "run_start" ? start.identity : undefined,
    outcome: ending?.type === "run_end" ? ending.outcome : "unknown", elapsedMs, observedMs, activeMs: elapsedMs === null ? null : Math.max(0, elapsedMs - approvalMs), approvalMs,
    firstToolMs: firstTool?.start ?? null, firstTextMs: firstText?.firstText ?? null,
    requests: new Set(attempts.map((span) => span.fields.requestId ?? span.id)).size, attempts: attempts.length,
    compactions: { attempts: compactions.filter((span) => span.status !== "skipped").length, successful: compactions.filter((span) => span.status === "completed").length,
      failed: compactions.filter((span) => span.status === "failed" || span.status === "cancelled").length, ineffective: compactions.filter((span) => span.status === "ineffective").length, skipped: compactions.filter((span) => span.status === "skipped").length },
    tools: all.filter((span) => span.kind === "tool").length, reads, spans: all, usage,
    usageIncomplete: !attempts.length || attempts.some((span) => span.usage.inputTokens === undefined || span.usage.outputTokens === undefined) };
}

/** Bounded metadata only: never accepts prompt, response, command, headers or thinking. */
export class RunMetrics {
  readonly runId = randomUUID();
  readonly events: MetricEvent[] = [];
  outcome = "running";
  warning: string | undefined;
  private readonly started: number;
  private readonly active = new Set<string>();
  private readonly firstEvents = new Set<string>();
  private readonly usages = new Map<string, MetricUsage>();
  private closed = false;
  constructor(identity: RunIdentity, private readonly write?: (event: MetricEvent) => void, private readonly clock: () => number = () => performance.now()) {
    this.started = clock(); this.emit({ type: "run_start", identity });
  }
  private emit(data: MetricEvent extends infer E ? E extends MetricEvent ? Omit<E, "version" | "runId" | "atMs" | "timestamp"> : never : never): void {
    if (this.closed) return;
    if (this.events.length >= 10000 && data.type !== "run_end") { this.warning = "性能记录已达条数上限，统计不完整"; return; }
    const event = { ...data, version: 1 as const, runId: this.runId, atMs: Math.max(0, this.clock() - this.started), timestamp: new Date().toISOString() } as MetricEvent;
    this.events.push(event);
    try { this.write?.(event); } catch { this.warning = "性能记录保存失败，任务继续；统计可能不完整"; }
  }
  start(kind: SpanKind, fields: MetricFields = {}): string { const spanId = randomUUID(); this.active.add(spanId); this.emit({ type: "span_start", spanId, kind, fields }); return spanId; }
  end(spanId: string, status: SpanStatus = "completed", fields: MetricFields = {}): void { if (!this.active.delete(spanId)) return; this.emit({ type: "span_end", spanId, status, fields }); }
  first(spanId: string, text: boolean): void { const key = `${spanId}:${text}`; if (this.firstEvents.has(key)) return; this.firstEvents.add(key); this.emit({ type: text ? "first_text" : "first_event", spanId }); }
  usage(spanId: string, usage: MetricUsage): void {
    const previous = this.usages.get(spanId) ?? {}; const next = { ...previous }; mergeUsage(next, usage);
    if (usageKeys.every((key) => next[key] === previous[key])) return;
    this.usages.set(spanId, next); this.emit({ type: "usage", spanId, usage: next });
  }
  read(evidence: ReadEvidence): void { this.emit({ type: "read", evidence }); }
  finish(outcome = this.outcome === "running" ? "interrupted" : this.outcome): void {
    if (this.closed) return;
    for (const span of [...this.active]) this.end(span, "unknown");
    this.outcome = outcome; this.emit({ type: "run_end", outcome }); this.closed = true;
  }
  summary(): RunSummary { return { ...summarizeMetrics(this.events, this.clock() - this.started), outcome: this.outcome, ...(this.warning ? { warning: this.warning } : {}) }; }
}
export function endpointIdentity(url: string): string {
  try { const parsed = new URL(url); return createHash("sha256").update(`${parsed.origin}${parsed.pathname}`).digest("hex").slice(0, 12); }
  catch { return "unknown"; }
}
export function recordMetrics(workDir: string, identity: RunIdentity): RunMetrics {
  const directory = join(workDir, ".qicode", "metrics"); let bytes = 0;
  return new RunMetrics(identity, (event) => {
    const line = JSON.stringify(event) + "\n"; bytes += Buffer.byteLength(line);
    if (bytes > 8 * 1024 * 1024) throw new Error("Metrics quota reached");
    mkdirSync(directory, { recursive: true }); appendFileSync(join(directory, `${event.runId}.jsonl`), line, { mode: 0o600 });
  });
}
export function loadMetrics(workDir: string, runId?: string): RunSummary | undefined {
  const directory = join(workDir, ".qicode", "metrics"); if (!existsSync(directory)) return;
  if (runId !== undefined && !/^[a-f0-9-]{36}$/.test(runId)) throw new Error("无效运行标识");
  const file = runId ? `${runId}.jsonl` : readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.jsonl$/.test(name)).sort((a, b) => statSync(join(directory, b)).mtimeMs - statSync(join(directory, a)).mtimeMs)[0];
  if (!file) return;
  const path = join(directory, file); if (!existsSync(path)) return;
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error("性能记录超出读取上限");
  const events: MetricEvent[] = []; let damaged = false;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try { const event: unknown = JSON.parse(line); if (validEvent(event) && event.runId === file.slice(0, -6)) events.push(event); else damaged = true; }
    catch { damaged = true; }
  }
  if (!events.length) return;
  return { ...summarizeMetrics(events), ...(damaged ? { warning: "记录有损坏，统计可能不完整" } : {}) };
}
function validEvent(value: unknown): value is MetricEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (e.version !== 1 || typeof e.runId !== "string" || typeof e.timestamp !== "string" || typeof e.atMs !== "number" || !Number.isFinite(e.atMs) || e.atMs < 0) return false;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (e.type === "run_start") return object(e.identity) && typeof e.identity.model === "string" && typeof e.identity.protocol === "string" && number(e.identity.contextWindow) && number(e.identity.maxOutput);
  if (e.type === "run_end") return typeof e.outcome === "string";
  if (e.type === "read") { const read = e.evidence; return object(read) && ["path", "version", "toolId", "kind"].every((key) => typeof read[key] === "string") && ["startLine", "endLine", "totalLines"].every((key) => number(read[key])); }
  if (typeof e.spanId !== "string") return false;
  if (e.type === "first_event" || e.type === "first_text") return true;
  if (e.type === "usage") return object(e.usage) && Object.entries(e.usage).every(([key, n]) => (usageKeys as readonly string[]).includes(key) && number(n));
  if (e.type === "span_start") return ["request", "tool", "permission", "backoff", "compaction", "initialization"].includes(e.kind as string) && object(e.fields);
  return e.type === "span_end" && ["completed", "failed", "cancelled", "timeout", "ineffective", "skipped", "unknown"].includes(e.status as string) && object(e.fields);
}
export function listMetrics(workDir: string): RunSummary[] {
  const directory = join(workDir, ".qicode", "metrics"); if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => /^[a-f0-9-]{36}\.jsonl$/.test(file))
    .sort((a, b) => statSync(join(directory, b)).mtimeMs - statSync(join(directory, a)).mtimeMs).slice(0, 50)
    .flatMap((file) => { try { const summary = loadMetrics(workDir, file.slice(0, -6)); return summary ? [summary] : []; } catch { return []; } });
}
export function formatMetrics(summary: RunSummary): string {
  const ms = (value: number | null | undefined): string => value == null ? "未知" : `${(value / 1000).toFixed(2)}s`;
  const durations = (kind: SpanKind) => unionDuration(summary.spans.filter((span) => span.kind === kind).map((span) => ({ start: span.start, end: span.end ?? summary.observedMs })));
  return ["任务性能（本地记录）", `运行：${summary.runId} · ${summary.outcome}`, `模型：${summary.identity?.model ?? "未知"} · 容量 ${summary.identity?.contextWindow ?? "未知"} (${summary.identity?.budgetSource ?? "未知"})`,
    `总耗时 ${ms(summary.elapsedMs)} · 有效耗时 ${ms(summary.activeMs)} · 授权等待 ${ms(summary.approvalMs)}`,
    `首次工具 ${ms(summary.firstToolMs)} · 首文本 ${ms(summary.firstTextMs)}（从任务开始计）`,
    `模型请求 ${summary.requests} · 尝试 ${summary.attempts} · 工具 ${summary.tools}`,
    `压缩 ${summary.compactions.attempts}：成功 ${summary.compactions.successful} / 无效 ${summary.compactions.ineffective} / 失败 ${summary.compactions.failed}`,
    `请求耗时 ${ms(durations("request"))} · 工具耗时 ${ms(durations("tool"))} · 压缩耗时 ${ms(durations("compaction"))} · 退避 ${ms(durations("backoff"))}`,
    "各项可能重叠，不相加；未知结束事件不记作 0。",
    `已知用量：输入 ${summary.usage.inputTokens ?? "未知"} · 缓存读取 ${summary.usage.cacheReadInputTokens ?? "未知"} · 输出 ${summary.usage.outputTokens ?? "未知"}${summary.usageIncomplete ? "（记录不完整）" : ""} · 费用未知`,
    `已读 ${summary.reads.length} 次 · 重复 ${summary.reads.filter((read) => read.kind === "repeat").length} · 重叠 ${summary.reads.filter((read) => read.kind === "overlap").length}`,
    ...summary.reads.slice(-12).map((read) => `${read.path}:${read.startLine}-${read.endLine} · ${read.version.slice(0, 12)} · ${read.kind}`),
    ...summary.spans.filter((span) => span.kind === "compaction").map((span) => `压缩 ${span.status ?? "未知"} · 消息估算 ${span.fields.beforeTokens ?? "未知"} → ${span.fields.afterTokens ?? "未知"}`),
    ...summary.spans.filter((span) => span.kind === "request").map((span) => `请求 ${span.fields.purpose ?? "main"} #${span.fields.attempt ?? 1} · ${span.status ?? "未知"} · 首事件 ${ms(span.firstEvent === undefined ? null : span.firstEvent - span.start)} · 首文本 ${ms(span.firstText === undefined ? null : span.firstText - span.start)}`),
    ...(summary.warning ? [summary.warning] : [])].join("\n");
}
