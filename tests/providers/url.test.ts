import { describe, expect, it } from "vitest";
import { buildProviderUrl } from "../../src/providers/url.js";

describe("buildProviderUrl", () => {
  it.each([
    ["https://api.anthropic.com", "messages", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/", "messages", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/v1", "messages", "https://api.anthropic.com/v1/messages"],
    ["https://gateway.example.com/proxy", "messages", "https://gateway.example.com/proxy/v1/messages"],
    ["https://api.openai.com/v1", "chat/completions", "https://api.openai.com/v1/chat/completions"],
  ])("builds %s + %s", (baseUrl, resource, expected) => {
    expect(buildProviderUrl(baseUrl, resource)).toBe(expected);
  });

  it("does not duplicate an existing resource path", () => {
    expect(
      buildProviderUrl(
        "https://api.openai.com/v1/chat/completions",
        "chat/completions",
      ),
    ).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("removes query strings and fragments from the base URL", () => {
    expect(
      buildProviderUrl("https://example.com/proxy?secret=value#fragment", "messages"),
    ).toBe("https://example.com/proxy/v1/messages");
  });

  it("rejects invalid schemes, credentials, and empty resources", () => {
    expect(() => buildProviderUrl("file:///tmp/api", "messages")).toThrow(
      "must use HTTP or HTTPS",
    );
    expect(() => buildProviderUrl("https://user:pass@example.com", "messages")).toThrow(
      "must not contain credentials",
    );
    expect(() => buildProviderUrl("https://example.com", "")).toThrow(
      "must not be empty",
    );
  });
});
