// Streaming call to a local Ollama model.
// Ollama streams newline-delimited JSON objects, one per token chunk.
const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "qwen2.5-coder:7b-instruct-q4_K_M";

const messages = [
  { role: "system", content: "You are a concise coding assistant." },
  { role: "user", content: "Write a Python function that checks if a number is prime." },
];

const res = await fetch(OLLAMA_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    messages,
    stream: true,
    options: { temperature: 0.2 },
  }),
});

if (!res.ok) {
  throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete last line for next chunk

  for (const line of lines) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    if (chunk.message?.content) {
      process.stdout.write(chunk.message.content);
    }
    if (chunk.done) {
      console.log("\n\n--- done, total_duration_ms:", Math.round(chunk.total_duration / 1e6), "---");
    }
  }
}
