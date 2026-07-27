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
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
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

export function redactSecrets(
  value: string,
  secrets: readonly string[],
): string {
  return secrets.reduce((redacted, secret) => {
    const normalized = secret.trim();
    return normalized === "" ? redacted : redacted.replaceAll(normalized, "[REDACTED]");
  }, value);
}
