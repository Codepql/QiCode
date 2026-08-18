import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileMailbox } from "../../src/teams/file-mailbox.js";

describe("FileMailbox", () => {
  it("delivers unread messages once and persists the cursor", async () => {
    const directory = tempDirectory();
    try {
      const writer = new FileMailbox(directory, "alice");
      const reader = new FileMailbox(directory, "alice");
      await writer.send("lead", "first");
      await writer.send("lead", "second");

      expect(reader.receiveSync().map((message) => message.text)).toEqual(["first", "second"]);
      expect(reader.receiveSync()).toEqual([]);

      await writer.send("lead", "third");
      const restartedReader = new FileMailbox(directory, "alice");
      expect(restartedReader.unreadCount()).toBe(1);
      await expect(restartedReader.receive()).resolves.toMatchObject([{ text: "third" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips malformed JSONL entries without losing valid unread messages", async () => {
    const directory = tempDirectory();
    try {
      const mailbox = new FileMailbox(directory, "alice");
      await mailbox.send("lead", "valid");
      expect(mailbox.receiveSync()).toMatchObject([{ text: "valid" }]);
      mailbox.markAllRead();
      expect(mailbox.unreadCount()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "qicode-mailbox-"));
}
