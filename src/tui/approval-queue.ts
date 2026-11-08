import type { PermissionResponse } from "../permissions/checker.js";

interface PendingApproval { show(): void; cancel(): void }
/** A modal serves one request at a time; cancelling a queued child must not resolve its neighbour. */
export class ApprovalQueue {
  private active: PendingApproval | undefined;
  private pending: PendingApproval[] = [];
  request(signal: AbortSignal, show: (finish: (action: PermissionResponse) => void) => void, hide: () => void): Promise<PermissionResponse> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (action: PermissionResponse): void => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", entry.cancel);
        if (this.active === entry) { this.active = undefined; hide(); }
        else this.pending = this.pending.filter((item) => item !== entry);
        resolve(action); queueMicrotask(() => this.pump());
      };
      const entry: PendingApproval = { show: () => show(finish), cancel: () => finish("deny") };
      if (signal.aborted) { finish("deny"); return; }
      signal.addEventListener("abort", entry.cancel, { once: true }); this.pending.push(entry); this.pump();
    });
  }
  private pump(): void {
    if (this.active) return;
    this.active = this.pending.shift(); this.active?.show();
  }
}
