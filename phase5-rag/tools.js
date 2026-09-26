// Tools for the combined agent: general filesystem/time tools (from Phase 3)
// plus search_company_docs, which wraps the RAG retrieval from query.js.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { withRetry } from "./retry.js";
import { LLM_BASE_URL, EMBED_MODEL, authHeaders } from "./config.js";

const TOP_K = 4;

const db = new pg.Client({
  host: "localhost",
  port: 5432,
  user: "rag",
  password: "rag",
  database: "rag",
});
let dbConnected = false;
async function ensureDb() {
  if (!dbConnected) {
    await db.connect();
    dbConnected = true;
  }
}

async function embed(text) {
  return withRetry(
    async () => {
      const res = await fetch(`${LLM_BASE_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      });
      if (!res.ok) {
        const err = new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      return (await res.json()).embedding;
    },
    { label: "embedding request" }
  );
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
  search_company_docs: async ({ query }) => {
    try {
      await ensureDb();
      const queryEmbedding = await embed(query);
      const { rows } = await db.query(
        `SELECT source, chunk_index, content, embedding <=> $1 AS distance
         FROM doc_chunks
         ORDER BY distance ASC
         LIMIT $2`,
        [`[${queryEmbedding.join(",")}]`, TOP_K]
      );
      if (!rows.length) return { result: "No company docs have been ingested yet." };
      return rows.map((r) => ({ source: r.source, distance: r.distance, content: r.content }));
    } catch (err) {
      return { error: err.message };
    }
  },
};
