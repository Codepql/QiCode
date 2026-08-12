import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "qicode-test-server", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: "Use echo to return the supplied message.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a message with a binary content block between text blocks.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    { type: "text", text: String(request.params.arguments?.message ?? "") },
    { type: "image", data: "AA==", mimeType: "image/png" },
    { type: "text", text: process.env.MCP_TEST_SUFFIX ?? "" },
  ],
}));

await server.connect(new StdioServerTransport());
