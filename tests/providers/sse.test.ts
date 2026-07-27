import { describe, expect, it } from "vitest";
import { AbortProviderError, ProviderResponseError } from "../../src/providers/errors.js";
import { parseSSE } from "../../src/providers/sse.js";

const encoder = new TextEncoder();

describe("parseSSE", () => {
  it("parses multiple events from one chunk", async () => {
    const messages = await collect(["data: one\n\ndata: two\n\n"]);
    expect(messages).toEqual([{ data: "one" }, { data: "two" }]);
  });

  it("parses an event split across single-byte chunks", async () => {
    const bytes = encoder.encode("event: message\ndata: 你好\n\n");
    const chunks = [...bytes].map((byte) => new Uint8Array([byte]));
    expect(await collectBytes(chunks)).toEqual([
      { event: "message", data: "你好" },
    ]);
  });

  it("supports CRLF and joins multiple data lines", async () => {
    expect(await collect(["event: update\r\ndata: first\r\ndata: second\r\n\r\n"])).toEqual([
      { event: "update", data: "first\nsecond" },
    ]);
  });

  it("ignores comments and supports empty data", async () => {
    expect(await collect([": keepalive\ndata:\n\n"])).toEqual([{ data: "" }]);
  });

  it("processes a final complete event without a trailing blank line", async () => {
    expect(await collect(["data: final"])).toEqual([{ data: "final" }]);
  });

  it("ignores frames without a data field", async () => {
    expect(await collect(["event: ping\n\n"])).toEqual([]);
  });

  it("rejects oversized buffers", async () => {
    await expect(
      collect(["data: too large"], { maxBufferChars: 4 }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("rejects oversized events and lines", async () => {
    await expect(
      collect(["data: 12345\n\n"], { maxEventChars: 5 }),
    ).rejects.toThrow("SSE event exceeded");
    await expect(
      collect(["data: 12345\n\n"], { maxLineChars: 5 }),
    ).rejects.toThrow("SSE line exceeded");
  });

  it("stops when its AbortSignal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(["data: ignored\n\n"], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortProviderError);
  });
});

async function collect(
  chunks: string[],
  options: Parameters<typeof parseSSE>[1] = {},
) {
  return collectBytes(chunks.map((chunk) => encoder.encode(chunk)), options);
}

async function collectBytes(
  chunks: Uint8Array[],
  options: Parameters<typeof parseSSE>[1] = {},
) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const messages = [];
  for await (const message of parseSSE(stream, options)) {
    messages.push(message);
  }
  return messages;
}
