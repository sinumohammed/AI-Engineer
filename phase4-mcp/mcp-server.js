// An MCP server exposing local tools over the standard MCP protocol
// (stdio transport). This is the same idea as phase3's tools.js, but now
// any MCP-compatible client - our own agent, Claude Code, Claude Desktop,
// anything - can discover and call these tools without custom wiring.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const server = new McpServer({ name: "local-tools", version: "1.0.0" });

server.registerTool(
  "list_files",
  {
    description: "List files and folders inside a directory on the local machine.",
    inputSchema: { dir_path: z.string().describe("Absolute or relative path to a directory.") },
  },
  async ({ dir_path }) => {
    try {
      const entries = readdirSync(dir_path).map((name) => {
        const isDir = statSync(join(dir_path, name)).isDirectory();
        return `${isDir ? "[dir] " : "[file]"} ${name}`;
      });
      return { content: [{ type: "text", text: JSON.stringify(entries) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

server.registerTool(
  "read_file",
  {
    description: "Read the text content of a file on the local machine.",
    inputSchema: { file_path: z.string().describe("Absolute or relative path to a file.") },
  },
  async ({ file_path }) => {
    try {
      const text = readFileSync(file_path, "utf-8").slice(0, 4000);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

server.registerTool(
  "get_current_time",
  {
    description: "Get the current local date and time.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: new Date().toString() }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
