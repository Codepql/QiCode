import type { ProviderConfig } from "../config/types.js";
import type { ConversationMessage } from "../conversation/types.js";
import type { StreamEvent, ToolDefinition } from "./events.js";

export interface ChatRequest {
  systemPrompt: string;
  messages: ConversationMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly config: ProviderConfig;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
}

export async function createProvider(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Provider> {
  if (config.protocol === "anthropic") {
    const { AnthropicProvider } = await import("./anthropic.js");
    return new AnthropicProvider(config, fetchImpl);
  }
  if (config.protocol === "openai") {
    const { OpenAIProvider } = await import("./openai.js");
    return new OpenAIProvider(config, fetchImpl);
  }
  throw new TypeError(`Unsupported provider protocol: ${String(config.protocol)}`);
}

export abstract class ProviderError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthenticationError extends ProviderError {
  readonly code = "authentication";

  constructor(message = "Provider authentication failed", options?: ErrorOptions) {
    super(message, options);
  }
}

export class RateLimitError extends ProviderError {
  readonly code = "rate_limit";
  readonly retryAfterSeconds?: number;

  constructor(retryAfterSeconds?: number, options?: ErrorOptions) {
    super("Provider rate limit reached", options);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ContextTooLongError extends ProviderError {
  readonly code = "context_too_long";

  constructor(message = "Conversation context is too long", options?: ErrorOptions) {
    super(message, options);
  }
}

export class NetworkError extends ProviderError {
  readonly code = "network";

  constructor(message = "Provider network request failed", options?: ErrorOptions) {
    super(message, options);
  }
}

export class ProviderResponseError extends ProviderError {
  readonly code = "invalid_response";

  constructor(message = "Provider returned an invalid response", options?: ErrorOptions) {
    super(message, options);
  }
}

export class AbortProviderError extends ProviderError {
  readonly code = "aborted";

  constructor(message = "Provider request cancelled", options?: ErrorOptions) {
    super(message, options);
  }
}

export function formatProviderError(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  let message: string;

  if (error instanceof AuthenticationError) {
    message = "Authentication failed. Check the API key, base URL, model, and account permissions.";
  } else if (error instanceof RateLimitError) {
    message = error.retryAfterSeconds === undefined
      ? "Rate limit reached. Try again later."
      : `Rate limit reached. Try again in ${error.retryAfterSeconds} seconds.`;
  } else if (error instanceof ContextTooLongError) {
    message = "Conversation context is too long. Start a new session or shorten the input.";
  } else if (error instanceof NetworkError) {
    message = "Network request failed. Check the connection and base URL.";
  } else if (error instanceof ProviderResponseError) {
    message = "The provider returned an invalid response.";
  } else if (error instanceof AbortProviderError) {
    message = "Request cancelled.";
  } else {
    message = "Unexpected provider error.";
  }

  return redactSecrets(message, secrets);
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => {
    const normalized = secret.trim();
    return normalized === "" ? redacted : redacted.replaceAll(normalized, "[REDACTED]");
  }, value);
}

const MAX_ERROR_BODY_CHARS = 4096;

export async function assertSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return;

  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  const body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS).toLowerCase();

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError();
  }
  if (response.status === 429) {
    throw new RateLimitError(retryAfter);
  }
  if (
    response.status === 413
    || body.includes("context_length")
    || body.includes("context window")
    || body.includes("too many tokens")
  ) {
    throw new ContextTooLongError();
  }
  throw new ProviderResponseError(`Provider request failed with HTTP ${response.status}`);
}

export function normalizeFetchError(error: unknown, signal?: AbortSignal): never {
  if (
    signal?.aborted
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError")
  ) {
    throw new AbortProviderError();
  }
  if (
    error instanceof AuthenticationError
    || error instanceof RateLimitError
    || error instanceof ContextTooLongError
    || error instanceof ProviderResponseError
  ) {
    throw error;
  }
  throw new NetworkError("Provider network request failed", { cause: error });
}

export function requireResponseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new ProviderResponseError("Provider response body is missing");
  return response.body;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

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
  const maxBufferChars = positiveLimit(options.maxBufferChars, DEFAULT_MAX_BUFFER_CHARS, "maxBufferChars");
  const maxEventChars = positiveLimit(options.maxEventChars, DEFAULT_MAX_EVENT_CHARS, "maxEventChars");
  const maxLineChars = positiveLimit(options.maxLineChars, DEFAULT_MAX_LINE_CHARS, "maxLineChars");
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
        if (message) yield message;
        boundary = findEventBoundary(buffer);
      }
    }

    if (buffer.length > 0) {
      const message = parseFrame(buffer, maxEventChars, maxLineChars);
      if (message) yield message;
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
    if (line === "" || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") {
      hasDataField = true;
      dataLines.push(value);
    } else if (field === "event") {
      event = value;
    }
  }

  if (!hasDataField) return undefined;
  return event === undefined
    ? { data: dataLines.join("\n") }
    : { event, data: dataLines.join("\n") };
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();

  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new AbortProviderError());
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortProviderError();
}

function assertBufferLimit(buffer: string, limit: number): void {
  if (buffer.length > limit) {
    throw new ProviderResponseError("SSE buffer exceeded the configured size limit");
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function buildProviderUrl(baseUrl: string, resource: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderResponseError("Provider base URL is invalid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderResponseError("Provider base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new ProviderResponseError("Provider base URL must not contain credentials");
  }

  const resourceSegments = splitPath(resource);
  if (resourceSegments.length === 0) {
    throw new ProviderResponseError("Provider resource path must not be empty");
  }

  const baseSegments = splitPath(url.pathname);
  const normalizedBase = endsWithSegments(baseSegments, resourceSegments)
    ? baseSegments.slice(0, -resourceSegments.length)
    : baseSegments;
  if (normalizedBase.at(-1)?.toLowerCase() !== "v1") normalizedBase.push("v1");

  url.pathname = `/${[...normalizedBase, ...resourceSegments].map(encodeURIComponent).join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new ProviderResponseError("Provider URL contains invalid path encoding");
    }
  });
}

function endsWithSegments(path: string[], suffix: string[]): boolean {
  return suffix.length <= path.length
    && suffix.every((segment, index) => path[path.length - suffix.length + index] === segment);
}
