// Phase 10, attachments step 2: long files. Step 1 put a file's whole text in
// the prompt, cut at MAX_CHARS (~12,000 characters, ~3 pages of a dense PDF),
// because Groq's free tier allows 8,000 tokens a minute. A 59-page tax guide
// was read only to page 3. Now a file over that size is searched like the
// handbook, but inside this process:
//
//   at upload:    pages -> chunks (~1,200 characters, never across a page, so
//                 every chunk has one page number) -> one vector per chunk,
//                 with the same embedding model as the handbook search
//                 (embed.js), kept with the chat in Redis (sessionStore.js)
//   per question: the question's vector against every chunk, plus a keyword
//                 match (exact figures like "$1 million" or "6.2%"), merged
//                 as in the handbook's hybrid search (tools.js) -> the best
//                 FILE_CHUNKS chunks, in page order
//
// A few hundred chunks need no database: comparing 400 vectors takes about a
// millisecond. Vectors are stored as int8 (768 bytes a chunk, not ~9 KB as
// JSON numbers); cosine similarity changes in the third decimal place.
import { embedDocuments, embedQuery } from "./embed.js";

export const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
// ~480,000 characters, ~100 dense pages. Embedding takes ~45 ms a chunk on
// the Mac (in-process nomic q8), so the cap also bounds the upload time.
export const MAX_CHUNKS = 400;
// How many chunks go into the prompt for one question: 4 x 1,200 characters
// is ~1,200 tokens, under step 1's ~3,000 for one short file.
export const FILE_CHUNKS = 4;

// Cut each page at line or word breaks near CHUNK_CHARS, with a little
// overlap so a sentence split between two chunks is whole in one of them.
function splitPage(text) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const breakAt = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (breakAt > start + CHUNK_CHARS / 2) end = breakAt;
    }
    pieces.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return pieces.filter(Boolean);
}

// pages: the text of each page, in order. Returns the chunks (at most
// MAX_CHUNKS) and how many pages they cover.
export function chunkPages(pages) {
  const chunks = [];
  let pagesRead = 0;
  for (const [i, text] of pages.entries()) {
    const pieces = splitPage(text.replace(/[ \t]+/g, " "));
    if (chunks.length + pieces.length > MAX_CHUNKS) break;
    chunks.push(...pieces.map((t) => ({ page: i + 1, text: t })));
    pagesRead = i + 1;
  }
  return { chunks, pagesRead };
}

const toInt8 = (vector) => Int8Array.from(vector, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));

export async function embedChunks(chunks) {
  const vectors = await embedDocuments(chunks.map((c) => `Page ${c.page}: ${c.text}`));
  const packed = new Int8Array(vectors.length * vectors[0].length);
  vectors.forEach((v, i) => packed.set(toInt8(v), i * v.length));
  return { vectors: Buffer.from(packed.buffer).toString("base64"), dims: vectors[0].length };
}

// Words that say what a question is about, plus figures ("6.2%", "$1
// million" -> "1"), which vectors match poorly. Shared with attachments.js.
const COMMON = new Set("about above after again also before being between could does doing from have here into just more most much other over same should some such than that their them then there these they this those through under until very what when where which while will with would your yours many".split(" "));
export const contentWords = (text) => new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !COMMON.has(w)));
const figures = (text) => new Set((text.match(/\d[\d,.]*%?/g) ?? []).map((f) => f.replace(/[.,]$/, "")).filter((f) => f.length >= 2 || f.endsWith("%")));
const has = (words, w) => words.has(w) || words.has(w.replace(/s$/, "")) || words.has(`${w}s`);

// Words of the question found in a chunk, counting only the ones that are
// rare in this file: in a tax guide "employer" or "list" is on most pages
// and says nothing about which page answers.
function keywordHits(question, chunks) {
  const terms = [...contentWords(question), ...figures(question)];
  const chunkWords = chunks.map((c) => new Set([...contentWords(c.text), ...figures(c.text)]));
  const rare = terms.filter((t) => chunkWords.filter((w) => has(w, t)).length <= Math.max(2, chunks.length * 0.15));
  return chunkWords.map((w) => rare.filter((t) => has(w, t)).length);
}

// Is a later question about this file at all? At least `min` of the
// question's words in one chunk, counting only the file's topic words - ones
// on at least 5% of its chunks. Measured on the 59-page tax guide: "two words
// anywhere in the file" matches almost any question; rare words alone missed
// "What is the social security wage base?" (every word is on 13-158 chunks);
// any two words in one chunk let in "How much paid parental leave do I get?"
// ("paid" is on 132 chunks, "leave" on 11). Topic words keep the handbook
// questions out and the tax questions in; "How do I request annual leave?"
// still gets the file (request, annual).
export function sharesTopicWords(question, att, min) {
  const chunkWords = att.chunks.map((c) => contentWords(c.text));
  const topical = [...contentWords(question)].filter((t) => chunkWords.filter((w) => has(w, t)).length >= Math.max(3, att.chunks.length * 0.05));
  return chunkWords.some((w) => topical.filter((t) => has(w, t)).length >= min);
}

// The FILE_CHUNKS chunks that best match the question, in page order.
export async function searchFile(att, question) {
  const q = await embedQuery(question);
  const packed = new Int8Array(Buffer.from(att.vectors, "base64").buffer.slice(0));
  const dims = att.dims;
  const similarity = att.chunks.map((_, i) => {
    let dot = 0, norm = 0;
    for (let d = 0; d < dims; d++) {
      const x = packed[i * dims + d];
      dot += x * q[d];
      norm += x * x;
    }
    return dot / (Math.sqrt(norm) || 1);
  });
  const hits = keywordHits(question, att.chunks);

  // Reciprocal Rank Fusion, as tools.js does for the handbook: a chunk strong
  // in either signal surfaces. A chunk with no rare word gets no keyword rank.
  const RRF_K = 60;
  const score = new Array(att.chunks.length).fill(0);
  const rank = (values, onlyPositive) =>
    values
      .map((v, i) => [v, i])
      .filter(([v]) => !onlyPositive || v > 0)
      .sort((a, b) => b[0] - a[0])
      .forEach(([, i], r) => (score[i] += 1 / (RRF_K + r + 1)));
  rank(similarity, false);
  rank(hits, true);
  return score
    .map((s, i) => [s, i])
    .sort((a, b) => b[0] - a[0])
    .slice(0, FILE_CHUNKS)
    .map(([, i]) => att.chunks[i])
    .sort((a, b) => a.page - b.page);
}
