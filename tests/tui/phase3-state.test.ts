import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPreferences, loadPreferences, preferencesPath, savePreferences, validatePreferences } from "../../src/tui/preferences.js";
import { inspectSession, sessionCatalog, sessionState, updateSessionState } from "../../src/session/catalog.js";
import { getSessionFilePath, saveMessage } from "../../src/session/session.js";
import { findReferenceFiles, inspectReference, referenceReminder } from "../../src/tui/file-references.js";
import { FileHistory } from "../../src/filehistory/filehistory.js";
import { modelChoiceDetail, modelHistoryIssue, withoutThinking } from "../../src/tui/model-switch.js";
import type { ConversationMessage } from "../../src/conversation/types.js";
import type { ProviderConfig } from "../../src/config/types.js";
const workspace = () => mkdtempSync(join(tmpdir(), "qicode-p3-"));
const from: ProviderConfig = { name: "one", protocol: "anthropic", model: "a", api_key: "SECRET", base_url: "http://unused", thinking: true };
const to: ProviderConfig = { ...from, name: "two", protocol: "openai", model: "b", thinking: false };

describe("third phase persisted state", () => {
  it("roundtrips project preferences without persisting provider secrets", () => {
    const workDir = workspace();
    const next = { ...defaultPreferences(), compact: true, toolPreview: false, highContrast: true, defaultMode: "plan" as const };
    savePreferences(workDir, next); expect(loadPreferences(workDir).preferences).toEqual(next);
    expect(readFileSync(preferencesPath(workDir), "utf8")).not.toContain("api_key");
  });
  it("rejects duplicate keys and reserved editor bindings without overwriting the file", () => {
    const workDir = workspace(); savePreferences(workDir, defaultPreferences());
    const before = readFileSync(preferencesPath(workDir), "utf8");
    expect(() => savePreferences(workDir, { ...defaultPreferences(), bindings: { ...defaultPreferences().bindings, tasks: "alt+m" } })).toThrow("冲突");
    expect(readFileSync(preferencesPath(workDir), "utf8")).toBe(before);
    expect(() => validatePreferences({ bindings: { tasks: "ctrl+c" } })).toThrow("保留键");
    expect(() => validatePreferences({ defaultMode: "bypassPermissions" })).toThrow();
  });
  it("reports malformed preferences and preserves their bytes", () => {
    const workDir = workspace(); mkdirSync(join(workDir, ".qicode")); writeFileSync(preferencesPath(workDir), "{bad");
    expect(loadPreferences(workDir).error).toBeDefined(); expect(readFileSync(preferencesPath(workDir), "utf8")).toBe("{bad");
  });
  it("indexes 100 structured sessions by real user title, summary and message count", () => {
    const workDir = workspace();
    for (let i = 0; i < 100; i++) saveMessage(workDir, `session-${i}`, { role: "system", type: "messages_v2", timestamp: new Date().toISOString(), content: JSON.stringify({ version: 2, start: 0, messages: [
      { role: "user", content: [{ type: "text", text: `修复模块 ${i}` }] },
      { role: "assistant", content: [{ type: "text", text: `处理结果 ${i}` }] },
    ] }) });
    updateSessionState(workDir, "session-99", { title: "支付边界修复", draft: "保留中文草稿 😀" });
    const cards = sessionCatalog(workDir); expect(cards).toHaveLength(100);
    expect(cards.find((card) => card.title.includes("支付边界"))).toMatchObject({ id: "session-99", messageCount: 2, firstMessage: "修复模块 99", summary: expect.stringContaining("处理结果 99") });
    expect(sessionState(workDir, "session-99").draft).toBe("保留中文草稿 😀");
    expect(() => updateSessionState(workDir, "../escape", { title: "x" })).toThrow();
  });
  it("warns about damaged tails and rejects an entirely unreadable conversation", () => {
    const workDir = workspace();
    saveMessage(workDir, "old", { role: "user", content: "hello", timestamp: new Date().toISOString() });
    appendFileSync(getSessionFilePath(workDir, "old"), "{damaged\n");
    expect(inspectSession(workDir, "old").warning).toContain("损坏");
    writeFileSync(getSessionFilePath(workDir, "broken"), "{bad\n");
    expect(() => inspectSession(workDir, "broken")).toThrow("损坏");
  });
  it("never silently transfers signed thinking to another model", () => {
    const messages: ConversationMessage[] = [{ role: "assistant", content: [
      { type: "thinking", thinking: "hidden", signature: "signed", hidden: true }, { type: "text", text: "visible" },
    ] }];
    expect(modelHistoryIssue(messages, from, to)).toContain("签名思考");
    expect(withoutThinking(messages)).toEqual([{ role: "assistant", content: [{ type: "text", text: "visible" }] }]);
    expect(messages[0]!.content).toHaveLength(2);
    expect(modelChoiceDetail(from)).not.toContain("SECRET"); expect(modelChoiceDetail(to)).toContain("未知");
  });
  it("blocks unpaired tool calls even when thinking conversion is possible", () => {
    const messages: ConversationMessage[] = [{ role: "assistant", content: [
      { type: "thinking", thinking: "hidden", signature: "signed", hidden: true },
      { type: "tool_use", id: "pending", name: "WriteFile", input: {} },
    ] }];
    expect(modelHistoryIssue(messages, from, to)).toContain("未配对");
  });
  it("finds Chinese and space paths while excluding dependencies and build artifacts", async () => {
    const workDir = workspace();
    for (const dir of ["src", "node_modules", "dist"]) { mkdirSync(join(workDir, dir)); writeFileSync(join(workDir, dir, "中文 file.ts"), "const secretBody = 1;"); }
    expect(await findReferenceFiles(workDir, "中文")).toEqual(["src/中文 file.ts"]);
    const file = await inspectReference(workDir, "src/中文 file.ts");
    expect(file.preview).toContain("secretBody"); expect(referenceReminder([file])).not.toContain("secretBody");
    expect(referenceReminder([file])).toContain("src/中文 file.ts");
    await expect(inspectReference(workDir, "../outside.txt")).rejects.toThrow();
    writeFileSync(join(workDir, "binary"), Buffer.from([0, 1, 2]));
    await expect(inspectReference(workDir, "binary")).rejects.toThrow("二进制");
  });
  it("previews checkpoint conflicts without modifying files or consuming checkpoints", () => {
    const workDir = workspace(); const file = join(workDir, "a.txt"); writeFileSync(file, "before");
    const history = new FileHistory(workDir, "preview"); history.trackEdit("a.txt"); writeFileSync(file, "after"); history.makeSnapshot(0, "change");
    expect(history.previewRewind(0).conflicts).toEqual([]); expect(readFileSync(file, "utf8")).toBe("after");
    writeFileSync(file, "user-edited");
    expect(history.previewRewind(0).conflicts).toHaveLength(1); expect(history.hasSnapshots()).toBe(true);
    expect(() => history.rewind(0)).toThrow("changed"); expect(readFileSync(file, "utf8")).toBe("user-edited");
  });
});
