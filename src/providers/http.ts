import {
  AbortProviderError,
  AuthenticationError,
  ContextTooLongError,
  NetworkError,
  ProviderResponseError,
  RateLimitError,
} from "./errors.js";

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
  if (!response.body) {
    throw new ProviderResponseError("Provider response body is missing");
  }
  return response.body;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}
