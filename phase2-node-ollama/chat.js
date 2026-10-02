// Non-streaming call to a local Ollama model.
// Ollama exposes a REST API on localhost:11434 once `ollama serve` is running.
const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "qwen3-coder:30b";

const messages = [
  { role: "system", content: "You are a concise coding assistant." },
  { role: "user", content: "Write a JavaScript function that reverses a string." },
];

const res = await fetch(OLLAMA_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    messages,
    stream: false,
    options: {
      temperature: 0.2, // lower = more deterministic, good for code
    },
  }),
});

if (!res.ok) {
  throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
}

const data = await res.json();
console.log("--- Model reply ---");
console.log(data.message.content);
console.log("--- Stats ---");
console.log({
  total_duration_ms: Math.round(data.total_duration / 1e6),
  eval_count: data.eval_count,
  eval_duration_ms: Math.round(data.eval_duration / 1e6),
});
