// Chunk every .txt/.md file under the document folders, embed each chunk via
// Ollama, store in Postgres.
//
// Phase 9 changes (the pipeline itself is still the Phase 5 one):
// - Reads sub-folders too. Phase 5 only read the top level of ./docs, which
//   was fine for 2 files and cannot load a 241-page handbook.
// - Two roots: ./docs (public, committed) and ./docs-private (ignored by git,
//   never pushed). Private chunks get a "private/" source prefix so they stay
//   identifiable after ingestion.
// - Chunk size/overlap and the target table come from the environment, so
//   chunking experiments can be ingested side by side and compared without
//   touching the table the chat app reads.
// - Removes chunks whose source file no longer exists, so the table always
//   mirrors what is on disk.
// Deliberately NOT changed yet: the text is chunked exactly as it is on disk
// (front matter, template tags and all). That is the baseline Phase 9 measures
// before improving anything.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { LLM_BASE_URL, EMBED_MODEL, authHeaders } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  { dir: join(HERE, "docs"), prefix: "" },
  { dir: join(HERE, "docs-private"), prefix: "private/" },
];
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 800);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? 100);
const TABLE = process.env.INGEST_TABLE ?? "doc_chunks";
if (!/^[a-z_][a-z0-9_]*$/.test(TABLE)) throw new Error(`Invalid INGEST_TABLE: ${TABLE}`);

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
  const res = await fetch(`${LLM_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embedding;
}

// Every .txt/.md file under `dir`, at any depth, as paths relative to `dir`.
function listDocs(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...listDocs(full).map((f) => join(name, f)));
    else if (name.endsWith(".txt") || name.endsWith(".md")) found.push(name);
  }
  return found;
}

await db.connect();

// An experiment table is a copy of doc_chunks' structure (columns, the
// generated tsvector column and both indexes).
if (TABLE !== "doc_chunks") {
  await db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (LIKE doc_chunks INCLUDING ALL)`);
}

const docs = ROOTS.flatMap(({ dir, prefix }) =>
  listDocs(dir).map((file) => ({ path: join(dir, file), source: prefix + file.split("\\").join("/") }))
);
if (!docs.length) {
  console.log(`No .txt/.md files found under ${ROOTS.map((r) => relative(HERE, r.dir)).join(" or ")}.`);
  process.exit(0);
}

console.log(`Ingesting ${docs.length} files into ${TABLE} (chunk size ${CHUNK_SIZE}, overlap ${CHUNK_OVERLAP})...`);
const startedAt = Date.now();
let totalChunks = 0;

for (const [n, doc] of docs.entries()) {
  const text = readFileSync(doc.path, "utf-8");
  const chunks = text.trim() ? chunkText(text) : [];
  const embeddings = [];
  for (const chunk of chunks) embeddings.push(await embed(chunk));

  await db.query("BEGIN");
  await db.query(`DELETE FROM ${TABLE} WHERE source = $1`, [doc.source]);
  for (let i = 0; i < chunks.length; i++) {
    await db.query(`INSERT INTO ${TABLE} (source, chunk_index, content, embedding) VALUES ($1, $2, $3, $4)`, [
      doc.source,
      i,
      chunks[i],
      `[${embeddings[i].join(",")}]`,
    ]);
  }
  await db.query("COMMIT");

  totalChunks += chunks.length;
  if ((n + 1) % 25 === 0 || n + 1 === docs.length) {
    console.log(`  ${n + 1}/${docs.length} files, ${totalChunks} chunks so far`);
  }
}

const { rowCount: removed } = await db.query(`DELETE FROM ${TABLE} WHERE source <> ALL($1)`, [
  docs.map((d) => d.source),
]);

await db.end();
console.log(
  `Done: ${totalChunks} chunks from ${docs.length} files in ${Math.round((Date.now() - startedAt) / 1000)}s` +
    (removed ? `, removed ${removed} chunks from files that no longer exist.` : ".")
);
