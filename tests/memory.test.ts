import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Provider } from "../src/llm/client.js";
import { MemoryExtractor } from "../src/memory/extractor.js";
import { MemoryManager, parseFrontmatter } from "../src/memory/manager.js";

const provider = (text: string): Provider => ({
  config: { name: "test", protocol: "openai", model: "test", base_url: "https://example.com", api_key: "key", thinking: false },
  async *stream() {
    yield { type: "text_delta", text } as const;
    yield { type: "done", stopReason: "end_turn" } as const;
  },
});

describe("memory", () => {
  it("parses frontmatter and builds a sorted project index", () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-memory-"));
    const directory = join(workDir, ".qicode", "memory");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "z.md"), "---\nname: Zeta\ndescription: last\ntype: project\n---\nbody");
    writeFileSync(join(directory, "a.md"), "---\nname: Alpha\ndescription: first\nmetadata:\n  type: feedback\n---\nbody");

    const manager = new MemoryManager(workDir);
    expect(parseFrontmatter(readFileSync(join(directory, "a.md"), "utf8"))).toMatchObject({ name: "Alpha", type: "feedback", body: "body" });
    expect(manager.buildSystemReminder()).toContain("[Alpha] (feedback): first");
    expect(readFileSync(join(directory, "MEMORY.md"), "utf8").split("\n")[0]).toContain("Alpha");
  });

  it("writes validated extracted memories to the project directory", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-memory-"));
    const extractor = new MemoryExtractor(provider([
      "MEMORY_NAME: project-style",
      "MEMORY_TYPE: project",
      "MEMORY_DESC: Use pnpm",
      "MEMORY_BODY: This project uses pnpm for all commands.",
      "---",
    ].join("\n")), workDir);

    await expect(extractor.extract("User says use pnpm.")).resolves.toEqual(["project-style"]);
    expect(readFileSync(join(workDir, ".qicode", "memory", "project-style.md"), "utf8")).toContain("This project uses pnpm");
  });

  it("does not write a note when the extractor returns NONE", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "qicode-memory-"));
    await expect(new MemoryExtractor(provider("NONE"), workDir).extract("hello")).resolves.toEqual([]);
    expect(new MemoryManager(workDir).getMemories()).toEqual([]);
  });
});
