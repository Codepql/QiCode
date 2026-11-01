import { describe, expect, it } from "vitest";
import { versionText } from "../src/main.js";
import { VERSION } from "../src/version.js";

describe("versionText", () => {
  it("returns the current QiCode version without printing during import", () => {
    expect(versionText()).toBe(`QiCode v${VERSION}`);
  });
});
