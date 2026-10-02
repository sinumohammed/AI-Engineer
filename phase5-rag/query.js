// RAG query: embed the question, retrieve nearest chunks from Postgres, ask the coder model to answer using them.
import pg from "pg";

const OLLAMA_URL = "http://localhost:11434/api";
const EMBED_MODEL = "nomic-embed-text";
const CHAT_MODEL = "qwen3-coder:30b";
const TOP_K = 4;

const question = process.argv[2];
if (!question) {
  console.log('Usage: node query.js "your question"');
  process.exit(1);
}

const db = new pg.Client({
  host: "localhost",
  port: 5432,
  user: "rag",
  password: "rag",
  database: "rag",
});

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  return (await res.json()).embedding;
}

async function chat(context, question) {
  const res = await fetch(`${OLLAMA_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "Answer using only the provided context. If the context doesn't contain the answer, say you don't know.",
        },
        { role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Chat request failed: ${res.status} ${await res.text()}`);
  return (await res.json()).message.content;
}

await db.connect();

const queryEmbedding = await embed(question);
const { rows } = await db.query(
  `SELECT source, chunk_index, content, embedding <=> $1 AS distance
   FROM doc_chunks
   ORDER BY distance ASC
   LIMIT $2`,
  [`[${queryEmbedding.join(",")}]`, TOP_K]
);

await db.end();

if (!rows.length) {
  console.log("No chunks in the database yet - run `npm run ingest` first.");
  process.exit(0);
}

console.log("--- Retrieved chunks ---");
for (const row of rows) {
  console.log(`[${row.source} #${row.chunk_index}] distance=${row.distance.toFixed(4)}`);
}

const context = rows.map((r) => r.content).join("\n---\n");
const answer = await chat(context, question);

console.log("\n--- Answer ---");
console.log(answer);
