// A minimal agent loop: ask the model, if it wants a tool, run the tool and
// feed the result back, repeat until it gives a plain text answer.
import { toolDefs, toolImpls } from "./tools.js";

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "qwen2.5-coder:7b-instruct-q4_K_M";

const userQuestion = process.argv[2] ?? "What files are in the current directory, and what time is it?";

const messages = [
  {
    role: "system",
    content: "You are a helpful assistant with access to tools. Use them when needed to answer accurately.",
  },
  { role: "user", content: userQuestion },
];

async function callModel() {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: toolDefs,
      stream: false,
      options: { temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Smaller/quantized local models sometimes skip Ollama's required
// <tool_call>...</tool_call> wrapper and just dump raw JSON into `content`.
// Ollama then can't populate `tool_calls`, so we fall back to detecting it
// ourselves. Production agent code always needs a fallback like this when
// running smaller models - they don't follow structured-output formats as
// reliably as larger hosted models.
// Scans text and returns every top-level {...} object, regardless of what
// separates them (nothing, a comma, wrapped in [...], newlines, etc).
// Balanced-brace scanning handles this far more reliably than a regex.
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

  // Smaller/quantized local models are inconsistent about how they emit
  // one or more calls: with or without <tool_call> tags, as a JSON array,
  // or as separate objects with no delimiter. Scan for every JSON object
  // rather than assuming one specific shape.
  const calls = [];
  for (const candidate of extractJsonObjects(msg.content)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.name) {
        calls.push({ function: { name: parsed.name, arguments: parsed.arguments ?? {} } });
      }
    } catch {
      // skip fragments that aren't valid standalone JSON
    }
  }
  return calls;
}

const MAX_TURNS = 5;

for (let turn = 0; turn < MAX_TURNS; turn++) {
  const data = await callModel();
  const msg = data.message;
  messages.push(msg);

  const toolCalls = extractToolCalls(msg);

  if (!toolCalls.length) {
    console.log("--- Final answer ---");
    console.log(msg.content);
    process.exit(0);
  }

  // Normalize onto the message so Ollama's chat template renders it as a
  // proper tool call when we resend the history next turn. The template
  // prefers `content` over `tool_calls` when both are set, so content must
  // be cleared too - otherwise the model just sees its raw unwrapped JSON
  // echoed back as plain text and repeats the same call forever.
  msg.tool_calls = toolCalls;
  msg.content = "";

  for (const call of toolCalls) {
    const name = call.function.name;
    const args = call.function.arguments;
    console.log(`--- Agent is calling tool: ${name}(${JSON.stringify(args)}) ---`);

    const impl = toolImpls[name];
    const result = impl ? impl(args) : { error: `Unknown tool: ${name}` };

    messages.push({
      role: "tool",
      content: JSON.stringify(result),
    });
  }
}

console.log("Stopped after max turns without a final answer.");
