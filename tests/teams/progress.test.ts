import { describe, expect, it } from "vitest";
import { createProgress, formatTokens, recordTokens, recordToolUse, summarizeActivities } from "../../src/teams/progress.js";

describe("team progress", () => {
  it("keeps the newest five tool activities and latest activity summary", () => {
    const progress = createProgress();
    for (let index = 0; index < 6; index += 1) recordToolUse(progress, "ReadFile", { file_path: `src/${index}.ts` });

    expect(progress.toolUseCount).toBe(6);
    expect(progress.recentActivities).toHaveLength(5);
    expect(summarizeActivities(progress.recentActivities)).toBe("Reading src/5.ts");
  });

  it("stores token totals and formats compact values", () => {
    const progress = createProgress();
    recordTokens(progress, 900, 200);
    expect(progress.tokenCount).toBe(1_100);
    expect(formatTokens(progress.tokenCount)).toBe("1.1k");
  });
});
