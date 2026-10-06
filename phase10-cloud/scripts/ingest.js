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
import { EMBED_BASE_URL, EMBED_MODEL, EMBED_PREFIX } from "../api/config.js";
import { cleanDocument } from "./cleanText.js";
import { chunkFixed, chunkSections } from "./chunker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  { dir: join(HERE, "../../phase5-rag/docs"), prefix: "" },
  { dir: join(HERE, "../../phase5-rag/docs-private"), prefix: "private/" },
];
// Defaults are the settings Phase 9.3 measured best (see
// phase9-real-docs/PHASE9_NOTES.md): cleaned text, cut at headings, each
// chunk labelled "Page > Section", 500-character chunks, nomic task
// prefixes. Phase 5's original pipeline is CLEAN=0 CHUNKING=fixed HEADER=0
// CHUNK_SIZE=800 CHUNK_OVERLAP=100 EMBED_PREFIX=0.
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 500);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? 60);
const TABLE = process.env.INGEST_TABLE ?? "doc_chunks";
// Phase 9.2: strip front matter, template tags, link URLs and HTML before
// chunking (see cleanText.js). CLEAN=0 turns it off.
const CLEAN = process.env.CLEAN !== "0";
// Phase 9.3: "sections" cuts at headings instead of every CHUNK_SIZE
// characters, and each chunk starts with "Page title > Section" (see
// chunker.js). CHUNKING=fixed / HEADER=0 bring back the old behaviour.
const CHUNKING = process.env.CHUNKING ?? "sections";
const HEADER = process.env.HEADER !== "0";
if (!/^[a-z_][a-z0-9_]*$/.test(TABLE)) throw new Error(`Invalid INGEST_TABLE: ${TABLE}`);

const db = new pg.Client({
  host: "localhost",
  port: 5432,
  user: "rag",
  password: "rag",
  database: "rag",
});

async function embed(text) {
  const res = await fetch(`${EMBED_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // nomic-embed-text was trained with task prefixes: documents as
    // "search_document: ...", questions as "search_query: ..." (config.js).
    body: JSON.stringify({ model: EMBED_MODEL, prompt: EMBED_PREFIX ? `search_document: ${text}` : text }),
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

console.log(
  `Ingesting ${docs.length} files into ${TABLE} (chunk size ${CHUNK_SIZE}, overlap ${CHUNK_OVERLAP}, ` +
    `${CLEAN ? "cleaned" : "raw"} text, ${CHUNKING} chunking${HEADER ? " with headers" : ""}` +
    `${EMBED_PREFIX ? ", embedding prefixes" : ""})...`
);
const startedAt = Date.now();
let totalChunks = 0;

for (const [n, doc] of docs.entries()) {
  const raw = readFileSync(doc.path, "utf-8");
  const { title, text } = CLEAN ? cleanDocument(raw) : { title: null, text: raw };
  const chunks = !text.trim()
    ? []
    : CHUNKING === "sections"
      ? chunkSections(text, { title, size: CHUNK_SIZE, overlap: CHUNK_OVERLAP, header: HEADER })
      : chunkFixed(text, { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP });
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
