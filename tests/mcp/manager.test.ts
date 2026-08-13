import { describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "../../src/config/types.js";
import type { MCPClient, MCPTool } from "../../src/mcp/client.js";
import { MCPManager } from "../../src/mcp/manager.js";

function fakeClient(options: {
  tools?: MCPTool[];
  instructions?: string;
  connectError?: Error;
  listError?: Error;
}) {
  return {
    connect: vi.fn(async () => {
      if (options.connectError) throw options.connectError;
    }),
    listTools: vi.fn(async () => {
      if (options.listError) throw options.listError;
      return options.tools ?? [];
    }),
    getInstructions: vi.fn(() => options.instructions ?? ""),
    disconnect: vi.fn(async () => {}),
  };
}

describe("MCPManager", () => {
  it("collects partial success while isolating connect and list failures", async () => {
    const clients = new Map([
      ["connect-fails", fakeClient({ connectError: new Error("offline") })],
      ["works", fakeClient({
        tools: [{
          name: "echo",
          description: "Echo input",
          inputSchema: { type: "object" },
        }],
        instructions: "Call echo with a message.",
      })],
      ["list-fails", fakeClient({ listError: new Error("bad tools response") })],
    ]);
    const order: string[] = [];
    const manager = new MCPManager((config: MCPServerConfig) => {
      order.push(config.name);
      return clients.get(config.name) as unknown as MCPClient;
    });

    const result = await manager.connectAll([
      { name: "connect-fails", command: "unused" },
      { name: "works", command: "unused" },
      { name: "list-fails", command: "unused" },
    ]);

    expect(order).toEqual(["connect-fails", "works", "list-fails"]);
    expect(result).toEqual({
      tools: [{
        serverName: "works",
        tool: {
          name: "echo",
          description: "Echo input",
          inputSchema: { type: "object" },
        },
      }],
      servers: ["works"],
      errors: [
        { serverName: "connect-fails", error: "offline" },
        { serverName: "list-fails", error: "bad tools response" },
      ],
      instructions: [{ serverName: "works", text: "Call echo with a message." }],
    });
    expect(clients.get("connect-fails")?.disconnect).toHaveBeenCalledOnce();
    expect(clients.get("list-fails")?.disconnect).toHaveBeenCalledOnce();
    expect(manager.getClient("works")).toBe(clients.get("works"));
  });

  it("disconnects all successful clients and clears the registry", async () => {
    const client = fakeClient({});
    const manager = new MCPManager(() => client as unknown as MCPClient);
    await manager.connectAll([{ name: "works", command: "unused" }]);

    await manager.disconnectAll();

    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(manager.getClient("works")).toBeUndefined();
  });
});
