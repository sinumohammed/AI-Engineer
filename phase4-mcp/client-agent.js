// Same agent loop as phase3, but tools now come from an MCP server instead
// of being wired in directly. The MCP client spawns mcp-server.js as a
// subprocess and talks to it over stdio using the MCP protocol.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "qwen3-coder:30b";

// --- 1. Connect to the MCP server and discover its tools ---
const transport = new StdioClientTransport({
  command: process.execPath, // the node binary running this script
  args: ["mcp-server.js"],
});
const mcp = new Client({ name: "phase4-agent", version: "1.0.0" });
await mcp.connect(transport);

const { tools: mcpTools } = await mcp.listTools();
console.log(`--- Connected to MCP server, discovered ${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")} ---`);

// Convert MCP tool descriptions into the schema Ollama's /api/chat expects.
const toolDefs = mcpTools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  },
}));

// --- 2. Same brace-scanning fallback parser from phase3 ---
function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function extractToolCalls(msg) {
  if (msg.tool_calls?.length) return msg.tool_calls;
  if (!msg.content) return [];
  const calls = [];
  for (const candidate of extractJsonObjects(msg.content)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.name) {
        calls.push({ function: { name: parsed.name, arguments: parsed.arguments ?? {} } });
      }
    } catch {
      // skip non-JSON fragments
    }
  }
  return calls;
}

async function callModel(messages) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: toolDefs, stream: false, options: { temperature: 0.2 } }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- 3. Agent loop, calling tools through the MCP client ---
const userQuestion = process.argv[2] ?? "What files are in the current directory, and what time is it?";
const messages = [
  { role: "system", content: "You are a helpful assistant with access to tools. Use them when needed to answer accurately." },
  { role: "user", content: userQuestion },
];

const MAX_TURNS = 5;
for (let turn = 0; turn < MAX_TURNS; turn++) {
  const data = await callModel(messages);
  const msg = data.message;
  messages.push(msg);

  const toolCalls = extractToolCalls(msg);
  if (!toolCalls.length) {
    console.log("--- Final answer ---");
    console.log(msg.content);
    await mcp.close();
    process.exit(0);
  }

  msg.tool_calls = toolCalls;
  msg.content = "";

  for (const call of toolCalls) {
    const { name, arguments: args } = call.function;
    console.log(`--- Agent is calling MCP tool: ${name}(${JSON.stringify(args)}) ---`);

    let resultText;
    try {
      const result = await mcp.callTool({ name, arguments: args });
      resultText = result.content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
    } catch (err) {
      resultText = JSON.stringify({ error: `Unknown tool or call failed: ${err.message}` });
    }

    messages.push({ role: "tool", content: resultText });
  }
}

console.log("Stopped after max turns without a final answer.");
await mcp.close();
