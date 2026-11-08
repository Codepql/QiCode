export const DEFAULT_EXECUTION = {
  taskTimeoutMs: 15 * 60_000, maxIterations: 80, requestIdleTimeoutMs: 120_000,
  commandTimeoutSeconds: 120, maxCommandTimeoutSeconds: 600,
  maxRepairRounds: 3, maxProviderRetries: 2, toolOutputDiskLimitBytes: 100 * 1024 * 1024,
};
export type ExecutionSettings = typeof DEFAULT_EXECUTION;
export interface ModelCapabilities { contextWindow: number; maxOutput: number }

export function parseExecution(value: unknown): Partial<ExecutionSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("execution must be an object");
  const result: Partial<ExecutionSettings> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_EXECUTION, key) || typeof amount !== "number" || !Number.isSafeInteger(amount)
      || amount < (key === "maxProviderRetries" ? 0 : 1) || amount > 2_147_483_647) throw new Error(`Invalid execution setting: ${key}`);
    result[key as keyof ExecutionSettings] = amount;
  }
  return result;
}

/** Only active execution consumes the task wall-clock budget. */
export class TaskBudget {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private remaining: number;
  private started = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(ms: number, external?: AbortSignal) {
    this.remaining = ms;
    this.signal = external ? AbortSignal.any([external, this.controller.signal]) : this.controller.signal;
    this.resume();
  }
  pause(): void {
    if (!this.timer) return;
    clearTimeout(this.timer); this.timer = undefined;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.started));
  }
  resume(): void {
    if (this.timer || this.signal.aborted) return;
    this.started = Date.now();
    this.timer = setTimeout(() => this.controller.abort(new Error("Task budget exhausted")), this.remaining);
  }
  dispose(): void { clearTimeout(this.timer); }
}

/** Share waiting time, not permissions, between a task and its descendants. */
export class ApprovalClock {
  private depth = 0;
  private readonly budgets = new Set<{ budget: TaskBudget; start(): void; end(): void }>();
  attach(budget: TaskBudget, start: () => void = () => {}, end: () => void = () => {}): () => void {
    const entry = { budget, start, end }; this.budgets.add(entry);
    if (this.depth) { budget.pause(); start(); }
    return () => { if (this.budgets.delete(entry) && this.depth) end(); };
  }
  enter(): () => void {
    if (this.depth++ === 0) for (const entry of this.budgets) { entry.budget.pause(); entry.start(); }
    let left = false;
    return () => { if (left) return; left = true; if (--this.depth === 0) for (const entry of this.budgets) { entry.end(); entry.budget.resume(); } };
  }
}

export async function awaitWithSignal<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
  let abort: () => void = () => {};
  try { return await Promise.race([value, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason ?? new Error("Cancelled")); signal.addEventListener("abort", abort, { once: true }); })]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Cancelled")); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function* withIdleTimeout<T>(source: AsyncIterable<T>, milliseconds: number, controller: AbortController, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: () => void = () => {};
      try {
        const next = await Promise.race([iterator.next(), new Promise<never>((_resolve, reject) => {
          cancel = () => reject(signal.reason ?? new Error("Cancelled"));
          signal.addEventListener("abort", cancel, { once: true });
          timer = setTimeout(() => { controller.abort(new Error("Model request idle timeout")); }, milliseconds);
        })]);
        if (next.done) return;
        yield next.value;
      } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
    }
  } finally { void iterator.return?.().catch(() => {}); }
}
