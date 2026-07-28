import { describe, expect, it } from "vitest";
import {
  BashDescription,
  EditFileDescription,
  GlobDescription,
  GrepDescription,
  ReadFileDescription,
  WriteFileDescription,
} from "../../src/tools/descriptions.js";

describe("tool descriptions", () => {
  it("provides a non-empty description for every planned tool", () => {
    const descriptions = [
      BashDescription,
      ReadFileDescription,
      WriteFileDescription,
      EditFileDescription,
      GlobDescription,
      GrepDescription,
    ];

    expect(descriptions).toHaveLength(6);
    for (const description of descriptions) {
      expect(description.trim().length).toBeGreaterThan(20);
    }
  });

  it("uses Chinese guidance for the model", () => {
    expect(ReadFileDescription).toContain("读取");
    expect(BashDescription).toContain("执行");
    expect(EditFileDescription).toContain("替换");
  });
});
