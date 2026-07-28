import { describe, expect, it } from "vitest";
import {
  boolArg,
  intArg,
  SKIP_DIRS,
  strArg,
} from "../../src/tools/types.js";

describe("tool argument helpers", () => {
  it("returns strings and falls back for non-strings", () => {
    const args = { good: "value", number: 42, missing: undefined };

    expect(strArg(args, "good")).toBe("value");
    expect(strArg(args, "number", "fallback")).toBe("fallback");
    expect(strArg(args, "missing", "fallback")).toBe("fallback");
  });

  it("accepts integer numbers and numeric strings", () => {
    const args = { number: 12, text: "8.9", invalid: "nope" };

    expect(intArg(args, "number", 1)).toBe(12);
    expect(intArg(args, "text", 1)).toBe(8);
    expect(intArg(args, "invalid", 1)).toBe(1);
  });

  it("returns booleans and ignores other types", () => {
    const args = { yes: true, no: false, text: "true" };

    expect(boolArg(args, "yes")).toBe(true);
    expect(boolArg(args, "no", true)).toBe(false);
    expect(boolArg(args, "text", true)).toBe(true);
  });

  it("contains directories that tools should skip", () => {
    expect(SKIP_DIRS.has(".git")).toBe(true);
    expect(SKIP_DIRS.has("node_modules")).toBe(true);
    expect(SKIP_DIRS.has("src")).toBe(false);
  });
});
