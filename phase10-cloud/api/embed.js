// Phase 10 step 4: one place for embeddings, used by search (tools.js) and
// by scripts/ingest.js - each had its own copy of the Ollama request before.
// EMBED_PROVIDER (config.js) picks Ollama, the same model inside this process
// ("local"), or Google's Gemini API.
//
// Both models are told which side of the search a text is on:
// - nomic-embed-text (Ollama or local) by a prefix in the text:
//   "search_document: " when storing, "search_query: " when searching
//   (Phase 9.3, EMBED_PREFIX).
// - Gemini by a task type: RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY.
import { withRetry } from "./retry.js";
import { EMBED_PROVIDER, EMBED_BASE_URL, EMBED_MODEL, EMBED_DIMENSIONS, EMBED_PREFIX, EMBED_LOCAL_DTYPE, GEMINI_API_KEY } from "./config.js";

// Written on each table by ingest.js and checked by search: vectors from two
// different models cannot be compared, and a mix-up gives no error - just
// search results that look plausible and are wrong.
export const EMBED_LABEL = `embeddings: ${EMBED_PROVIDER} ${EMBED_MODEL} ${EMBED_DIMENSIONS}`;
// Tables ingested before Phase 10 have no label; this is what they hold.
export const UNLABELLED_TABLE = "embeddings: ollama nomic-embed-text 768";

export async function embedQuery(text) {
  return (await embed([text], "query"))[0];
}

export async function embedDocuments(texts) {
  return embed(texts, "document");
}

function embed(texts, side) {
  if (!texts.length) return [];
  if (EMBED_PROVIDER === "gemini") return embedGemini(texts, side);
  if (EMBED_PROVIDER === "local") return embedLocal(texts, side);
  return embedOllama(texts, side);
}

const nomicPrefix = (side) => (EMBED_PREFIX ? (side === "query" ? "search_query: " : "search_document: ") : "");

async function embedOllama(texts, side) {
  const prefix = nomicPrefix(side);
  const vectors = [];
  for (const text of texts) {
    vectors.push(
      await withRetry(
        async () => {
          const data = await post(`${EMBED_BASE_URL}/api/embeddings`, {}, { model: EMBED_MODEL, prompt: prefix + text });
          return data.embedding;
        },
        { label: "embedding request" }
      )
    );
  }
  return vectors;
}

// The nomic model inside this process. Loaded on first use and kept for the
// life of the process (~0.15 s from the cache; the first run downloads it from
// Hugging Face). Mean pooling + normalizing is how nomic-embed-text-v1.5 makes
// one vector per text - measured identical to Ollama's at fp32/fp16.
// Started once and shared, so questions arriving together load it only once.
let extractor = null;
async function loadExtractor() {
  const { pipeline, env } = await import("@huggingface/transformers");
  // A hosted function can write only to /tmp.
  if (process.env.VERCEL) env.cacheDir = "/tmp/transformers-cache";
  return pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5", { dtype: EMBED_LOCAL_DTYPE });
}

async function embedLocal(texts, side) {
  extractor ??= loadExtractor();
  const fe = await extractor;
  const prefix = nomicPrefix(side);
  const vectors = [];
  for (const text of texts) {
    vectors.push(Array.from((await fe(prefix + text, { pooling: "mean", normalize: true })).data));
  }
  return vectors;
}

// The free tier allows 100 texts a minute, counted per text - a batch of 100
// counts as 100 (measured 2026-10-06). Batching still saves round trips;
// pacing comes from waiting as long as each 429 says (retry.js).
const GEMINI_BATCH = 100;

async function embedGemini(texts, side) {
  if (!GEMINI_API_KEY) throw new Error("EMBED_PROVIDER=gemini needs GEMINI_API_KEY");
  const taskType = side === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const vectors = [];
  for (let i = 0; i < texts.length; i += GEMINI_BATCH) {
    const batch = texts.slice(i, i + GEMINI_BATCH);
    const data = await withRetry(
      () =>
        post(
          `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`,
          { "x-goog-api-key": GEMINI_API_KEY },
          {
            requests: batch.map((text) => ({
              model: `models/${EMBED_MODEL}`,
              content: { parts: [{ text }] },
              taskType,
              outputDimensionality: EMBED_DIMENSIONS,
            })),
          }
        ),
      { label: "Gemini embedding request" }
    );
    vectors.push(...data.embeddings.map((e) => e.values));
  }
  return vectors;
}

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json();
  const text = await res.text();
  const err = new Error(`Embedding request failed: ${res.status} ${text.slice(0, 300)}`);
  err.status = res.status;
  if (res.status === 429) {
    // Gemini puts the wait in the body ("retryDelay": "37s"), not a header.
    // A per-day quota is not worth waiting for: no delay, so it fails now.
    const perDay = /PerDay/.test(text);
    const delay = text.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
    if (delay && !perDay) err.retryAfterMs = Math.ceil(Number(delay[1]) + 1) * 1000;
    if (perDay) err.message = `Gemini daily embedding quota used up - try again tomorrow. ${err.message}`;
  }
  throw err;
}
