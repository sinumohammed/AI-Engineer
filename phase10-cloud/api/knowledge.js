// Step 1 of app knowledge: each connected app brings its own help pages, the
// way it brings its own API (openapiTools.js) - the pages live in the app's
// repo and change with its features; this service only reads and searches them.
//
//   registry entry: "knowledge": "https://garagentic.co/help.md"
//   npm run app -- add | refresh  -> fetch the Markdown -> pages and sections
//                                 -> chunks -> embedded -> APP_KNOWLEDGE_TABLE, tagged with the app
//   a question                    -> searched only among the apps this caller may use (apps.js)
//
// The file: Markdown. "# Title" starts a page, "## " / "### " a section in it.
// Text before the first "# " is a page called "Overview".
// Roles: a line "Roles: owner, manager" right under a heading limits that page
// or section to those roles (a section's own line wins over its page's); no
// line means everyone. The app sends the asking user's role (/api/ask user.role)
// and apps.js keeps the steps of other roles' pages out of the answer.
// Re-indexing replaces all of the app's chunks in one transaction, so a
// question never sees half of an old file and half of a new one.
import { db } from "./tools.js";
import { embedDocuments, embedQuery, EMBED_LABEL } from "./embed.js";
import { APP_KNOWLEDGE_TABLE, EMBED_DIMENSIONS } from "./config.js";

const MAX_BYTES = 300000;
const MAX_PAGES = 200;
const MAX_CHUNKS = 500;
// ~300 tokens: a section usually fits in one excerpt, so a how-to keeps its steps together.
const MAX_CHUNK_CHARS = 1200;

export class KnowledgeError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const TABLE = () => {
  if (!/^[a-z_][a-z0-9_]*$/.test(APP_KNOWLEDGE_TABLE)) throw new Error(`Invalid APP_KNOWLEDGE_TABLE: ${APP_KNOWLEDGE_TABLE}`);
  return APP_KNOWLEDGE_TABLE;
};

const ROLES_LINE = /^roles?:\s*(.+)$/i;
const ROLE = /^[a-z0-9_-]{1,30}$/;
export const parseRoles = (text) => [...new Set(text.split(",").map((r) => r.trim().toLowerCase()).filter((r) => ROLE.test(r)))];

// Markdown -> [{ title, roles, sections: [{ heading, roles, text }] }]. roles: [] = everyone.
export function parsePages(markdown) {
  const pages = [];
  let page = null;
  let section = null;
  // The heading whose "Roles:" line may come next (blank lines between are fine).
  let open = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const h1 = line.match(/^#\s+(.+?)\s*#*\s*$/);
    const h2 = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/);
    if (h1) {
      page = { title: h1[1].slice(0, 120), roles: [], sections: [] };
      pages.push(page);
      section = null;
      open = page;
      continue;
    }
    if (open && line.trim()) {
      const roles = line.trim().match(ROLES_LINE);
      const target = open;
      open = null;
      if (roles) {
        target.roles = parseRoles(roles[1]);
        continue;
      }
    }
    if (!page) {
      if (!line.trim()) continue;
      page = { title: "Overview", roles: [], sections: [] };
      pages.push(page);
    }
    if (h2) {
      section = { heading: h2[1].slice(0, 120), roles: null, lines: [] };
      page.sections.push(section);
      open = section;
      continue;
    }
    if (!section) {
      section = { heading: "", roles: null, lines: [] };
      page.sections.push(section);
    }
    section.lines.push(line);
  }
  return pages
    .map((p) => ({
      title: p.title,
      roles: p.roles,
      sections: p.sections.map((s) => ({ heading: s.heading, roles: s.roles ?? p.roles, text: s.lines.join("\n").trim() })).filter((s) => s.text),
    }))
    .filter((p) => p.sections.length);
}

// A section's text in pieces of at most MAX_CHUNK_CHARS, cut between paragraphs.
function pieces(text) {
  const out = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    for (let p = para.trim(); p; ) {
      const take = p.length > MAX_CHUNK_CHARS ? p.slice(0, MAX_CHUNK_CHARS) : p;
      p = p.slice(take.length).trim();
      if (cur && cur.length + take.length + 2 > MAX_CHUNK_CHARS) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${take}` : take;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Each chunk starts with where it came from, like a handbook excerpt ("Quotes > Send a quote"),
// so the search and the relevance judge see the topic too. `source` is the label under the answer.
export function chunkPages(app, pages) {
  return pages.flatMap((p) =>
    p.sections.flatMap((s) =>
      pieces(s.text).map((text) => ({
        source: `${app} help: ${p.title}`,
        roles: s.roles,
        content: `${app} help: ${p.title}${s.heading ? ` > ${s.heading}` : ""}\n${text}`,
      }))
    )
  );
}

// The app's file, checked: Markdown text, not an HTML page (a single-page app answers
// unknown paths with its index.html - that is a wrong URL, not help pages) and not JSON.
export async function fetchKnowledge(url, token, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "text/markdown, text/plain", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new KnowledgeError(`could not fetch the knowledge file: ${err.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : err.message}`, 502);
  }
  if (!res.ok) throw new KnowledgeError(`the knowledge file answered ${res.status}${res.status === 401 || res.status === 403 ? " - check the token" : ""}`, 502);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new KnowledgeError(`the knowledge file is over ${MAX_BYTES / 1000} KB`);
  const start = text.trimStart();
  if (/^</.test(start)) throw new KnowledgeError("the knowledge URL returned an HTML page, not Markdown - check the URL");
  if (/^[[{]/.test(start)) throw new KnowledgeError("the knowledge file must be Markdown (# Page, ## Section), not JSON");
  const pages = parsePages(text);
  if (!pages.length) throw new KnowledgeError("the knowledge file has no text");
  if (pages.length > MAX_PAGES) throw new KnowledgeError(`the knowledge file has ${pages.length} pages - up to ${MAX_PAGES}`);
  return pages;
}

let ready = null;
async function ensureTable() {
  ready ??= (async () => {
    const t = TABLE();
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await db.query(`CREATE TABLE IF NOT EXISTS ${t} (
      app text NOT NULL,
      source text NOT NULL,
      chunk_index int NOT NULL,
      content text NOT NULL,
      embedding vector(${EMBED_DIMENSIONS}) NOT NULL,
      roles text[] NOT NULL DEFAULT '{}',
      indexed_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS roles text[] NOT NULL DEFAULT '{}'`);
    await db.query(`CREATE INDEX IF NOT EXISTS ${t}_app_idx ON ${t} (app)`);
    // Vectors from two embedding models cannot be compared (embed.js): the table carries its model's label.
    const { rows } = await db.query("SELECT obj_description(to_regclass($1), 'pg_class') AS label, (SELECT count(*) FROM " + t + ")::int AS n", [t]);
    if (!rows[0].label || !rows[0].n) await db.query(`COMMENT ON TABLE ${t} IS '${EMBED_LABEL}'`);
    else if (rows[0].label !== EMBED_LABEL) throw new Error(`Table ${t} holds "${rows[0].label}" but this service embeds with "${EMBED_LABEL}"`);
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

// Replace the app's chunks with these pages'. Returns what the registry shows.
export async function indexKnowledge(app, pages) {
  const chunks = chunkPages(app, pages);
  if (chunks.length > MAX_CHUNKS) throw new KnowledgeError(`the knowledge file makes ${chunks.length} chunks - up to ${MAX_CHUNKS} (shorter pages)`);
  await ensureTable();
  const vectors = await embedDocuments(chunks.map((c) => c.content));
  const t = TABLE();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM ${t} WHERE app = $1`, [app]);
    const params = [];
    const values = chunks.map((c, i) => {
      params.push(app, c.source, i, c.content, `[${vectors[i].join(",")}]`, c.roles);
      const b = i * 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    if (values.length) await client.query(`INSERT INTO ${t} (app, source, chunk_index, content, embedding, roles) VALUES ${values.join(", ")}`, params);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { pages: pages.length, chunks: chunks.length, indexedAt: new Date().toISOString() };
}

export async function removeKnowledge(app) {
  await ensureTable();
  await db.query(`DELETE FROM ${TABLE()} WHERE app = $1`, [app]);
}

// The nearest chunks among these apps only - the scope is in the query itself.
// Every role's chunks come back (with their roles): apps.js decides what the asker may read.
export async function searchKnowledge(query, apps, k = 10) {
  if (!apps.length) return [];
  await ensureTable();
  const vector = await embedQuery(query);
  const { rows } = await db.query(
    `SELECT app, source, content, roles, embedding <=> $1 AS distance FROM ${TABLE()} WHERE app = ANY($2::text[]) ORDER BY distance ASC LIMIT $3`,
    [`[${vector.join(",")}]`, apps, k]
  );
  return rows;
}
