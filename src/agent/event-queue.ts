/** Bridge tool progress callbacks to the Agent's async event stream. */
export async function* withEvents<T, R>(operation: (emit: (event: T) => void) => Promise<R>): AsyncGenerator<T, R> {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  const pending = operation((event) => { queue.push(event); wake?.(); });
  void pending.then(() => { settled = true; wake?.(); }, () => { settled = true; wake?.(); });
  while (!settled || queue.length) {
    if (queue.length) yield queue.shift()!;
    else await new Promise<void>((resolve) => { wake = resolve; });
  }
  return await pending;
}
