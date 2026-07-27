import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../../src/tui/app.js";

describe("App", () => {
  it("renders the real input for a single configured provider", () => {
    const view = render(<App providers={[{
      name: "test",
      protocol: "openai",
      model: "test-model",
      base_url: "https://example.com",
      api_key: "test-key",
      thinking: false,
    }]} />);

    expect(view.lastFrame()).toContain("QiCode v0.1.0");
    expect(view.lastFrame()).toContain("test-model");
    expect(view.lastFrame()).not.toContain("openai · test-model");
    expect(view.lastFrame()).not.toContain("Static preview only");
  });
});
