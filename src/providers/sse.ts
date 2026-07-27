import { AbortProviderError, ProviderResponseError } from "./errors.js";

export interface SSEMessage {
  event?: string;
  data: string;
}

export interface SSEParserOptions {
  signal?: AbortSignal;
  maxBufferChars?: number;
  maxEventChars?: number;
  maxLineChars?: number;
}

const DEFAULT_MAX_BUFFER_CHARS = 1024 * 1024;
const DEFAULT_MAX_EVENT_CHARS = 256 * 1024;
const DEFAULT_MAX_LINE_CHARS = 128 * 1024;

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  options: SSEParserOptions = {},
): AsyncGenerator<SSEMessage> {
  const maxBufferChars = positiveLimit(
    options.maxBufferChars,
    DEFAULT_MAX_BUFFER_CHARS,
    "maxBufferChars",
  );
  const maxEventChars = positiveLimit(
    options.maxEventChars,
    DEFAULT_MAX_EVENT_CHARS,
    "maxEventChars",
  );
  const maxLineChars = positiveLimit(
    options.maxLineChars,
    DEFAULT_MAX_LINE_CHARS,
    "maxLineChars",
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      throwIfAborted(options.signal);
      const result = await readWithAbort(reader, options.signal);
      if (result.done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      assertBufferLimit(buffer, maxBufferChars);

      let boundary = findEventBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const message = parseFrame(frame, maxEventChars, maxLineChars);
        if (message) {
          yield message;
        }
        boundary = findEventBoundary(buffer);
      }
    }

    if (buffer.length > 0) {
      const message = parseFrame(buffer, maxEventChars, maxLineChars);
      if (message) {
        yield message;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(
  frame: string,
  maxEventChars: number,
  maxLineChars: number,
): SSEMessage | undefined {
  if (frame.length > maxEventChars) {
    throw new ProviderResponseError("SSE event exceeded the configured size limit");
  }

  const dataLines: string[] = [];
  let event: string | undefined;
  let hasDataField = false;

  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.length > maxLineChars) {
      throw new ProviderResponseError("SSE line exceeded the configured size limit");
    }
    if (line === "" || line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      hasDataField = true;
      dataLines.push(value);
    } else if (field === "event") {
      event = value;
    }
  }

  if (!hasDataField) {
    return undefined;
  }

  return event === undefined
    ? { data: dataLines.join("\n") }
    : { event, data: dataLines.join("\n") };
}

function findEventBoundary(
  buffer: string,
): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }

  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new AbortProviderError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortProviderError();
  }
}

function assertBufferLimit(buffer: string, limit: number): void {
  if (buffer.length > limit) {
    throw new ProviderResponseError("SSE buffer exceeded the configured size limit");
  }
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
