import { describe, expect, it } from "vitest";
import {
  AbortProviderError,
  AuthenticationError,
  ContextTooLongError,
  NetworkError,
  ProviderResponseError,
  RateLimitError,
  formatProviderError,
  redactSecrets,
} from "../../src/llm/client.js";

describe("formatProviderError", () => {
  it.each([
    [new AuthenticationError(), "Authentication failed"],
    [new RateLimitError(30), "Rate limit reached. Try again in 30 seconds."],
    [new ContextTooLongError(), "Conversation context is too long"],
    [new NetworkError(), "Network request failed"],
    [new ProviderResponseError(), "The provider returned an invalid response"],
    [new AbortProviderError(), "Request cancelled"],
  ])("formats %s as a safe user message", (error, expected) => {
    expect(formatProviderError(error)).toContain(expected);
  });

  it("does not expose unknown error details", () => {
    const error = new Error("request failed with api-key-secret");
    expect(formatProviderError(error, ["api-key-secret"])).toBe(
      "Unexpected provider error.",
    );
  });

  it("redacts every occurrence of known secrets", () => {
    expect(
      redactSecrets(
        "Authorization: secret-value; repeated secret-value",
        ["secret-value"],
      ),
    ).toBe("Authorization: [REDACTED]; repeated [REDACTED]");
  });

  it("ignores empty secret values when redacting", () => {
    expect(redactSecrets("safe message", ["", "   "])).toBe("safe message");
  });
});
