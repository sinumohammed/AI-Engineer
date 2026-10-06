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
import { DATABASE_URL, DATABASE_IS_LOCAL, DOCS_TABLE, EMBED_PROVIDER, EMBED_PREFIX } from "../api/config.js";
import { embedDocuments, EMBED_LABEL, UNLABELLED_TABLE } from "../api/embed.js";
import { cleanDocument } from "./cleanText.js";
import { chunkFixed, chunkSections } from "./chunker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Phase 10: private documents never leave this machine. They are ingested
// only when the text stays here twice over: embedded here (Ollama or the
// in-process model - a hosted provider like Gemini receives every text it
// embeds) and stored here (a hosted database like Neon holds the text itself).
// Decided in code from the settings, not by a setting of its own.
const PRIVATE_ALLOWED = EMBED_PROVIDER !== "gemini" && DATABASE_IS_LOCAL;
const ROOTS = [
  { dir: join(HERE, "../../phase5-rag/docs"), prefix: "" },
  ...(PRIVATE_ALLOWED ? [{ dir: join(HERE, "../../phase5-rag/docs-private"), prefix: "private/" }] : []),
];
// Defaults are the settings Phase 9.3 measured best (see
// phase9-real-docs/PHASE9_NOTES.md): cleaned text, cut at headings, each
// chunk labelled "Page > Section", 500-character chunks, nomic task
// prefixes. Phase 5's original pipeline is CLEAN=0 CHUNKING=fixed HEADER=0
// CHUNK_SIZE=800 CHUNK_OVERLAP=100 EMBED_PREFIX=0.
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 500);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? 60);
const TABLE = process.env.INGEST_TABLE ?? DOCS_TABLE;
// Phase 9.2: strip front matter, template tags, link URLs and HTML before
// chunking (see cleanText.js). CLEAN=0 turns it off.
const CLEAN = process.env.CLEAN !== "0";
// Phase 9.3: "sections" cuts at headings instead of every CHUNK_SIZE
// characters, and each chunk starts with "Page title > Section" (see
// chunker.js). CHUNKING=fixed / HEADER=0 bring back the old behaviour.
const CHUNKING = process.env.CHUNKING ?? "sections";
const HEADER = process.env.HEADER !== "0";
if (!/^[a-z_][a-z0-9_]*$/.test(TABLE)) throw new Error(`Invalid INGEST_TABLE: ${TABLE}`);

const db = new pg.Client({ connectionString: DATABASE_URL });

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

// Phase 10: the table is created here, from schema.sql's definition, instead
// of copying doc_chunks (LIKE doc_chunks) - a new database such as Neon has
// no doc_chunks to copy. Index names match what LIKE produced, so existing
// tables get no duplicate indexes. Does nothing for a table that exists.
await db.query("CREATE EXTENSION IF NOT EXISTS vector");
await db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
)`);
await db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_embedding_idx ON ${TABLE} USING hnsw (embedding vector_cosine_ops)`);
await db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_content_tsv_idx ON ${TABLE} USING gin (content_tsv)`);

// Phase 10: one embedding model per table (see embed.js). Refuse to add
// vectors from another model to a table that already has some.
const { rows: labelRows } = await db.query(
  `SELECT obj_description(to_regclass($1), 'pg_class') AS label, (SELECT count(*)::int FROM ${TABLE}) AS n`,
  [TABLE]
);
const existingLabel = labelRows[0].label ?? (labelRows[0].n ? UNLABELLED_TABLE : null);
if (existingLabel && existingLabel !== EMBED_LABEL) {
  console.error(`${TABLE} holds "${existingLabel}", this run would add "${EMBED_LABEL}". Use another INGEST_TABLE.`);
  process.exit(1);
}
await db.query(`COMMENT ON TABLE ${TABLE} IS '${EMBED_LABEL}'`);
if (!PRIVATE_ALLOWED) {
  console.log(`Skipping docs-private: ${DATABASE_IS_LOCAL ? `${EMBED_PROVIDER} is a hosted embedding provider` : "the database is not on this machine"}.`);
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
    `, ${EMBED_LABEL}${EMBED_PROVIDER === "ollama" && EMBED_PREFIX ? ", embedding prefixes" : ""})...`
);
const startedAt = Date.now();
let totalChunks = 0;
let unchangedFiles = 0;

for (const [n, doc] of docs.entries()) {
  const raw = readFileSync(doc.path, "utf-8");
  const { title, text } = CLEAN ? cleanDocument(raw) : { title: null, text: raw };
  const chunks = !text.trim()
    ? []
    : CHUNKING === "sections"
      ? chunkSections(text, { title, size: CHUNK_SIZE, overlap: CHUNK_OVERLAP, header: HEADER })
      : chunkFixed(text, { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP });

  // Phase 10: a file whose chunks are already stored, unchanged, is not
  // embedded again. Makes a slow, rate-limited Gemini run resumable - run it
  // again after a stop and it continues where it was - and re-ingesting
  // unchanged files fast.
  const { rows: stored } = await db.query(`SELECT content FROM ${TABLE} WHERE source = $1 ORDER BY chunk_index`, [doc.source]);
  if (chunks.length && stored.length === chunks.length && stored.every((r, i) => r.content === chunks[i])) {
    totalChunks += chunks.length;
    unchangedFiles++;
    continue;
  }
  const embeddings = await embedDocuments(chunks);

  await db.query("BEGIN");
  await db.query(`DELETE FROM ${TABLE} WHERE source = $1`, [doc.source]);
  // Phase 10: one INSERT per file instead of one per chunk - over the
  // network to a hosted database every query costs a round trip.
  if (chunks.length) {
    const values = chunks.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(", ");
    const params = chunks.flatMap((chunk, i) => [doc.source, i, chunk, `[${embeddings[i].join(",")}]`]);
    await db.query(`INSERT INTO ${TABLE} (source, chunk_index, content, embedding) VALUES ${values}`, params);
  }
  await db.query("COMMIT");

  totalChunks += chunks.length;
  if ((n + 1) % 25 === 0 || n + 1 === docs.length) {
    console.log(`  ${n + 1}/${docs.length} files, ${totalChunks} chunks so far (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }
}

const { rowCount: removed } = await db.query(`DELETE FROM ${TABLE} WHERE source <> ALL($1)`, [
  docs.map((d) => d.source),
]);

await db.end();
console.log(
  `Done: ${totalChunks} chunks from ${docs.length} files (${unchangedFiles} unchanged, not embedded again) ` +
    `in ${Math.round((Date.now() - startedAt) / 1000)}s` +
    (removed ? `, removed ${removed} chunks from files that no longer exist.` : ".")
);
