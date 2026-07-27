import { describe, expect, it } from "vitest";
import { versionText } from "../src/main.js";

describe("versionText", () => {
  it("returns the current QiCode version without printing during import", () => {
    expect(versionText()).toBe("QiCode v0.1.0");
  });
});
