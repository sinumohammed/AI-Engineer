// Tools for the combined agent: general filesystem/time tools (from Phase 3)
// plus search_company_docs, which wraps the RAG retrieval from query.js.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { embedQuery, EMBED_LABEL, UNLABELLED_TABLE } from "./embed.js";
import { DATABASE_URL, DOCS_TABLE, RELEVANCE_THRESHOLD } from "./config.js";

const TOP_K = 4;

// Codes/IDs like "XJ-2200": letters, optional hyphen, digits. Used only to
// decide whether a query is naming a specific identifier, so we know when
// to trust the keyword search's exact-match signal (see below).
const IDENTIFIER_RE = /\b[A-Za-z]{1,6}-?\d{2,6}\b/g;
function extractIdentifiers(text) {
  return [...new Set(text.match(IDENTIFIER_RE) ?? [])];
}

// Phase 10: a pool instead of one pg.Client. A Client that fails to connect
// once can never connect again ("Client has already been connected. You
// cannot reuse a client.") - found in step 3 with a wrong password: every
// later search failed until the server restarted. And when the database
// closed the connection (Postgres restarted), the Client's unhandled error
// crashed the whole server. A pool opens connections as queries need them
// and drops broken ones, so either only fails the query it happens during -
// including when Neon closes connections as it suspends after 5 idle minutes.
const db = new pg.Pool({ connectionString: DATABASE_URL });
// The pool reports a broken idle connection here; without a listener Node
// treats it as an unhandled error and the process exits.
db.on("error", (err) => console.error(`[db] idle connection error: ${err.message}`));

// Phase 10 step 4: refuse to search a table whose vectors come from a
// different embedding model than the questions' (labels: embed.js). Checked
// once per table; the error says which settings to change.
const checkedTables = new Set();
async function checkTable(table) {
  if (checkedTables.has(table)) return;
  const { rows } = await db.query("SELECT obj_description(to_regclass($1), 'pg_class') AS label, to_regclass($1) AS t", [table]);
  if (!rows[0].t) throw new Error(`Table ${table} does not exist - run scripts/ingest.js, or set DOCS_TABLE`);
  const label = rows[0].label ?? UNLABELLED_TABLE;
  if (label !== EMBED_LABEL) {
    throw new Error(`Table ${table} holds "${label}" but questions are embedded with "${EMBED_LABEL}" - set EMBED_PROVIDER/DOCS_TABLE to match`);
  }
  checkedTables.add(table);
}

// Diagnostics for the Phase 9 retrieval eval: plain vector search, more
// results than the agent ever sees, against any chunk table (experiment
// tables are created by ingest.js with INGEST_TABLE). Not used by the agents.
export async function vectorSearch(query, { k = 10, table = DOCS_TABLE } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid table: ${table}`);
  await checkTable(table);
  const queryEmbedding = await embedQuery(query);
  const { rows } = await db.query(
    `SELECT source, chunk_index, content, embedding <=> $1 AS distance
     FROM ${table}
     ORDER BY distance ASC
     LIMIT $2`,
    [`[${queryEmbedding.join(",")}]`, k]
  );
  return rows;
}

// How many chunks of a table contain a piece of text, compared the way a
// reader sees it: link addresses and markdown emphasis characters dropped,
// case and line breaks ignored (the same rules as the eval's normalize()).
// Lets the eval tell "search did not find it" apart from "no single chunk
// holds it" (the text was cut in two by a chunk boundary).
export async function countChunksContaining(text, table = DOCS_TABLE) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid table: ${table}`);
  const readable = (sql) =>
    `regexp_replace(regexp_replace(regexp_replace(${sql}, '\\]\\((<[^>]*>|[^)]*)\\)', '', 'g'), '[\\[\\]_*\`]', '', 'g'), '\\s+', ' ', 'g')`;
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM ${table}
     WHERE position(lower(${readable("$1")}) in lower(${readable("content")})) > 0`,
    [text]
  );
  return rows[0].n;
}

export const toolDefs = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and folders inside a directory on the local machine.",
      parameters: {
        type: "object",
        properties: {
          dir_path: { type: "string", description: "Absolute or relative path to a directory." },
        },
        required: ["dir_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the text content of a file on the local machine.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute or relative path to a file." },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current local date and time.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_company_docs",
      description:
        "Search internal company documents for information relevant to a question. Use this whenever the question could be about internal company processes, policies, or docs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The question or topic to search company docs for." },
        },
        required: ["query"],
      },
    },
  },
];

export const toolImpls = {
  list_files: ({ dir_path }) => {
    try {
      return readdirSync(dir_path).map((name) => {
        const full = join(dir_path, name);
        const isDir = statSync(full).isDirectory();
        return `${isDir ? "[dir] " : "[file]"} ${name}`;
      });
    } catch (err) {
      return { error: err.message };
    }
  },
  read_file: ({ file_path }) => {
    try {
      return readFileSync(file_path, "utf-8").slice(0, 4000);
    } catch (err) {
      return { error: err.message };
    }
  },
  get_current_time: () => new Date().toString(),
  // `k`: how many candidates to return. The agents get 4; the Phase 9.4
  // reranker asks for more and picks the best of them (see retrieve.js).
  search_company_docs: async ({ query, k = TOP_K }) => {
    try {
      await checkTable(DOCS_TABLE);
      const queryEmbedding = await embedQuery(query);

      const [{ rows: vectorRows }, { rows: keywordRows }] = await Promise.all([
        db.query(
          `SELECT source, chunk_index, content, embedding <=> $1 AS distance
           FROM ${DOCS_TABLE}
           ORDER BY distance ASC
           LIMIT $2`,
          [`[${queryEmbedding.join(",")}]`, k]
        ),
        // websearch_to_tsquery lexes a hyphenated code like "XJ-2200" as a
        // phrase ('xj' <-> '-2200'), ANDed with the query's other terms - so
        // a chunk only matches if that EXACT code appears in it. This is the
        // exact-match signal pure vector distance can't give us.
        db.query(
          `SELECT source, chunk_index, content,
                  ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS rank
           FROM ${DOCS_TABLE}
           WHERE content_tsv @@ websearch_to_tsquery('english', $1)
           ORDER BY rank DESC
           LIMIT $2`,
          [query, k]
        ),
      ]);

      if (!vectorRows.length) return { result: "No company docs have been ingested yet." };

      // Merge both ranked lists via Reciprocal Rank Fusion so chunks strong
      // in either signal (semantic OR exact keyword match) surface, instead
      // of only ever trusting vector distance.
      const RRF_K = 60;
      const key = (r) => `${r.source}#${r.chunk_index}`;
      const scored = new Map();
      const byKey = new Map();
      vectorRows.forEach((r, i) => {
        scored.set(key(r), (scored.get(key(r)) ?? 0) + 1 / (RRF_K + i + 1));
        byKey.set(key(r), r);
      });
      keywordRows.forEach((r, i) => {
        scored.set(key(r), (scored.get(key(r)) ?? 0) + 1 / (RRF_K + i + 1));
        if (!byKey.has(key(r))) byKey.set(key(r), r);
      });
      const merged = [...scored.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, k)
        .map(([k]) => byKey.get(k))
        .map((r) => ({ source: r.source, distance: r.distance, content: r.content }));

      // A row found only by keyword search (not in vectorRows) has no
      // `distance` - so the relevance decision must NOT read it off `merged`
      // (a keyword-only hit would then fail `undefined < threshold` and get
      // dropped, defeating the point of hybrid search). Callers gate on
      // these explicit fields instead, computed from vectorRows/keywordRows
      // directly, never from the merged/display list.
      merged.bestVectorDistance = Math.min(...vectorRows.map((r) => r.distance));
      merged.keywordHit = keywordRows.length > 0;

      // Proved live (Phase 5.6): vector distance alone can score a made-up
      // code ("XJ-9999") nearly as close as the real one ("XJ-2200") that's
      // merely nearby in embedding space - a false positive that would make
      // the agent confidently answer about the WRONG equipment. Deliberately
      // NOT based on the keyword search above (that ANDs every word in the
      // query, so ordinary phrasing that doesn't share the doc's exact
      // wording - e.g. query says "schedule", doc only says "calibration" -
      // would trip a false mismatch). Instead: check directly whether the
      // identifier itself literally occurs in the vector-relevant chunk's
      // content, independent of how the rest of the question is phrased.
      const queryIdentifiers = extractIdentifiers(query);
      const identifierMismatch =
        queryIdentifiers.length > 0 &&
        vectorRows.some((r) => r.distance < RELEVANCE_THRESHOLD) &&
        !vectorRows.some((r) =>
          queryIdentifiers.some((id) => r.content.toLowerCase().includes(id.toLowerCase()))
        );

      merged.identifierMismatch = identifierMismatch;
      return merged;
    } catch (err) {
      // Phase 10: logged, because nothing downstream does - a wrong
      // DATABASE_URL looked exactly like "no relevant documents" (found
      // testing step 3 with a wrong password: empty search, no log line).
      console.error(`[search] document search failed: ${err.message}`);
      return { error: err.message };
    }
  },
};
