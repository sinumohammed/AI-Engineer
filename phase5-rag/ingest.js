// Chunk every .txt/.md file in ./docs, embed each chunk via Ollama, store in Postgres.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const OLLAMA_URL = "http://localhost:11434/api/embeddings";
const EMBED_MODEL = "nomic-embed-text";
const DOCS_DIR = "./docs";
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

const db = new pg.Client({
  host: "localhost",
  port: 5432,
  user: "rag",
  password: "rag",
  database: "rag",
});

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

async function embed(text) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embedding;
}

await db.connect();

const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".txt") || f.endsWith(".md"));
if (!files.length) {
  console.log(`No .txt/.md files found in ${DOCS_DIR}. Add some docs and re-run.`);
  process.exit(0);
}

for (const file of files) {
  const fullPath = join(DOCS_DIR, file);
  const text = readFileSync(fullPath, "utf-8");
  const chunks = chunkText(text);

  await db.query("DELETE FROM doc_chunks WHERE source = $1", [file]);

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i]);
    await db.query(
      "INSERT INTO doc_chunks (source, chunk_index, content, embedding) VALUES ($1, $2, $3, $4)",
      [file, i, chunks[i], `[${embedding.join(",")}]`]
    );
    console.log(`Ingested ${file} chunk ${i + 1}/${chunks.length}`);
  }
}

await db.end();
console.log("Done.");
