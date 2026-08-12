import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCPClient, expandEnv } from "../../src/mcp/client.js";

describe("expandEnv", () => {
  it("expands braced and plain references and empties missing values", () => {
    expect(expandEnv("Bearer ${TOKEN}:$TOKEN:$MISSING", { TOKEN: "secret" })).toBe(
      "Bearer secret:secret:",
    );
  });
});

describe("MCPClient", () => {
  it("completes the stdio handshake, lists and calls tools, and disconnects", async () => {
    const client = new MCPClient({
      name: "fixture",
      command: process.execPath,
      args: [join(process.cwd(), "tests", "fixtures", "mcp-stdio-server.mjs")],
      env: { MCP_TEST_SUFFIX: "${SUFFIX}" },
    });
    const previousSuffix = process.env.SUFFIX;
    process.env.SUFFIX = "from-env";

    try {
      await client.connect();

      expect(client.getInstructions()).toBe("Use echo to return the supplied message.");
      expect(await client.listTools()).toEqual([
        {
          name: "echo",
          description: "Echo a message with a binary content block between text blocks.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ]);
      const output = await client.callTool("echo", { message: "hello" });
      expect(output).toContain("hello");
      expect(output).toContain('"type":"image"');
      expect(output).toContain("from-env");
    } finally {
      await client.disconnect();
      if (previousSuffix === undefined) delete process.env.SUFFIX;
      else process.env.SUFFIX = previousSuffix;
    }

    await expect(client.listTools()).rejects.toThrow("is not connected");
  });

  it("rejects a server without a command or URL", async () => {
    const client = new MCPClient({ name: "invalid" });

    await expect(client.connect()).rejects.toThrow("needs either command or url");
  });

  it("rejects non-HTTP remote URLs before connecting", async () => {
    const client = new MCPClient({ name: "invalid-url", url: "file:///tmp/mcp" });

    await expect(client.connect()).rejects.toThrow("has an invalid HTTP URL");
  });
});
