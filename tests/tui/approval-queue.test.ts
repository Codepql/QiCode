import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../../src/tui/approval-queue.js";
import type { PermissionResponse } from "../../src/permissions/checker.js";

describe("concurrent approval dialogs", () => {
  it("keeps each answer bound to its request while cancelling a queued child", async () => {
    const queue = new ApprovalQueue(); const shown: string[] = []; let answer: ((action: PermissionResponse) => void) | undefined;
    const show = (id: string) => (finish: (action: PermissionResponse) => void) => { shown.push(id); answer = finish; };
    const parent = new AbortController(), child = new AbortController(), sibling = new AbortController();
    const a = queue.request(parent.signal, show("parent"), () => {}), b = queue.request(child.signal, show("child"), () => {}), c = queue.request(sibling.signal, show("sibling"), () => {});
    expect(shown).toEqual(["parent"]); child.abort(); await expect(b).resolves.toBe("deny");
    answer!("allowTask"); await expect(a).resolves.toBe("allowTask"); expect(shown).toEqual(["parent", "sibling"]);
    answer!("allow"); await expect(c).resolves.toBe("allow");
  });
  it("cancels the displayed request and presents the next one exactly once", async () => {
    const queue = new ApprovalQueue(); const a = new AbortController(), b = new AbortController(); let shown = 0;
    const first = queue.request(a.signal, () => { shown++; }, () => {});
    let finish: ((action: PermissionResponse) => void) | undefined;
    const second = queue.request(b.signal, (answer) => { shown++; finish = answer; }, () => {});
    a.abort(); await expect(first).resolves.toBe("deny"); expect(shown).toBe(2); finish!("deny"); finish!("allow"); await expect(second).resolves.toBe("deny");
  });
});
