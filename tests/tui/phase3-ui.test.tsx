import React from "react";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/tui/app.js";
import { ChoiceDialog } from "../../src/tui/choice-dialog.js";
import { defaultPreferences, loadPreferences, providerKey, savePreferences } from "../../src/tui/preferences.js";
import { saveMessage } from "../../src/session/session.js";
import { sessionCatalog, sessionState, updateSessionState } from "../../src/session/catalog.js";
import type { ProviderConfig } from "../../src/config/types.js";
import type { ChatRequest, Provider } from "../../src/llm/client.js";

const first: ProviderConfig = { name: "first", model: "model-a", protocol: "openai", api_key: "SECRET-A", base_url: "http://unused", thinking: false };
const second: ProviderConfig = { ...first, name: "second", model: "model-b", api_key: "SECRET-B" };
const views: ReturnType<typeof render>[] = [];
afterEach(() => { for (const view of views.splice(0)) view.unmount(); });
const wait = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2000, interval: 15 });
function setup(failSecond = false, gate?: Promise<void>) {
  const workDir = mkdtempSync(join(tmpdir(), "qicode-p3-ui-"));
  savePreferences(workDir, { ...defaultPreferences(), preferredProvider: providerKey(first) });
  const requests: { model: string; request: ChatRequest }[] = [];
  const factory = vi.fn(async (config: ProviderConfig) => {
    const provider: Provider = { config, async *stream(request) {
      requests.push({ model: config.model, request });
      if (config === second && failSecond) throw new Error("endpoint offline");
      if (gate && config === first) await gate;
      yield { type: "text_delta", text: "answer" }; yield { type: "done", stopReason: "stop" };
    } };
    return { provider, systemPrompt: "test-system" };
  });
  const view = render(<App providers={[first, second]} workDir={workDir} runtimeFactory={factory} />); views.push(view);
  return { workDir, requests, factory, view, text: () => view.lastFrame() ?? "" };
}

describe("phase three UI", () => {
  it("clears an autosaved draft immediately when its prompt is accepted", async () => {
    const { view, text, workDir, requests } = setup();
    view.stdin.write("autosaved prompt"); await wait(() => text().includes("autosaved prompt"));
    await wait(() => sessionCatalog(workDir).some((card) => card.firstMessage === "autosaved prompt"));
    const id = sessionCatalog(workDir).find((card) => card.firstMessage === "autosaved prompt")!.id;
    expect(sessionState(workDir, id).draft).toBe("autosaved prompt");
    view.stdin.write("\r"); await wait(() => requests.length > 0);
    expect(sessionState(workDir, id).draft).toBe("");
  });
  it("searches 100 choices and previews without triggering selection or leaking keystrokes", async () => {
    const select = vi.fn(); const close = vi.fn();
    const view = render(<ChoiceDialog title="会话" columns={80} maxHeight={12} items={Array.from({ length: 100 }, (_, i) => ({ id: String(i), label: `session-${i}`, detail: `preview-${i}` }))} onSelect={select} onClose={close} />); views.push(view);
    view.stdin.write("session-99"); await wait(() => (view.lastFrame() ?? "").includes("1/100"));
    view.stdin.write("\t"); await wait(() => (view.lastFrame() ?? "").includes("preview-99"));
    expect(select).not.toHaveBeenCalled(); view.stdin.write("\x1b"); await wait(() => (view.lastFrame() ?? "").includes("搜索"));
    view.stdin.write("\r"); await wait(() => select.mock.calls.some(([id]) => id === "99"));
  });
  it("preserves a draft when closing a modal and when switching away and back", async () => {
    const { view, text, workDir } = setup();
    saveMessage(workDir, "past", { role: "user", content: "previous prompt", timestamp: new Date().toISOString() });
    updateSessionState(workDir, "past", { title: "历史标题", draft: "历史草稿" });
    view.stdin.write("新的中文草稿"); await wait(() => text().includes("新的中文草稿"));
    view.stdin.write("\x1bs"); await wait(() => text().includes("会话选择"));
    view.stdin.write("历史标题"); await wait(() => /1\/\d+/.test(text()));
    view.stdin.write("\r"); await wait(() => text().includes("历史草稿"));
    const previous = sessionCatalog(workDir).find((card) => card.id !== "past");
    expect(previous).toBeDefined(); expect(sessionState(workDir, previous!.id).draft).toBe("新的中文草稿");
    view.stdin.write("\x1bs"); await wait(() => text().includes("会话选择"));
    view.stdin.write("新的中文草稿"); await wait(() => text().includes("1/2"));
    view.stdin.write("\r"); await wait(() => text().includes("新的中文草稿") && !text().includes("会话选择"));
  });
  it("switches the next request while retaining visible history and keeping credentials out of UI", async () => {
    const { view, text, requests, workDir } = setup();
    view.stdin.write("hello"); await wait(() => text().includes("hello")); view.stdin.write("\r");
    await wait(() => text().includes("answer"));
    view.stdin.write("\x1bm"); await wait(() => text().includes("选择模型"));
    view.stdin.write("\x1b[B"); view.stdin.write("\r"); await wait(() => text().includes("已切换 second"));
    expect(text()).not.toContain("SECRET"); expect(loadPreferences(workDir).preferences.preferredProvider).toBe(providerKey(second));
    view.stdin.write("continue"); await wait(() => text().includes("continue")); view.stdin.write("\r");
    await wait(() => requests.some((entry) => entry.model === "model-b"));
    const request = requests.find((entry) => entry.model === "model-b")!.request;
    expect(JSON.stringify(request.messages)).toContain("hello");
  });
  it("defers model adoption until a running request finishes", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const { view, text, requests, factory } = setup(false, gate);
    view.stdin.write("hello"); await wait(() => text().includes("hello")); view.stdin.write("\r");
    await wait(() => requests.length > 0);
    view.stdin.write("\x1bm"); await wait(() => text().includes("选择模型"));
    view.stdin.write("\x1b[B"); view.stdin.write("\r"); await wait(() => text().includes("已登记模型"));
    expect(factory.mock.calls.some(([config]) => config === second)).toBe(false);
    release(); await wait(() => text().includes("已切换 second"));
  });
  it("rolls back a new model after its first failing request", async () => {
    const { view, text, requests, workDir } = setup(true);
    view.stdin.write("\x1bm"); await wait(() => text().includes("选择模型"));
    view.stdin.write("\x1b[B"); view.stdin.write("\r"); await wait(() => text().includes("已切换 second"));
    view.stdin.write("hello"); await wait(() => text().includes("hello")); view.stdin.write("\r");
    await wait(() => text().includes("已回到 model-a"));
    expect(requests.some((entry) => entry.model === "model-b")).toBe(true);
    expect(loadPreferences(workDir).preferences.preferredProvider).toBe(providerKey(first));
  });
  it("saves settings immediately and keeps the original logo on return", async () => {
    const { view, text, workDir } = setup();
    view.stdin.write("\x1bb"); await wait(() => text().includes("偏好设置"));
    view.stdin.write("\r"); await wait(() => loadPreferences(workDir).preferences.compact);
    await wait(() => text().includes("( o.o )"));
    expect(text()).not.toContain("SECRET");
  });
});
