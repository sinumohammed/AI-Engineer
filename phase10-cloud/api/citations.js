// Phase 9.6: citations - every answer from the documents says where each fact
// came from.
//
// The excerpts given to the model are numbered, and the model is asked to put
// the number after each fact it uses: "...12 weeks of paid leave [1]." The
// code then turns the numbers it actually used into a source list. Only cited
// excerpts are listed, so the list shows what the answer relied on, not just
// what search happened to return.
//
// Each chunk already starts with its location ("Leave types > Annual leave",
// added by the Phase 9.3 chunker), which becomes the readable label.

export const CITE_INSTRUCTION =
  "After each fact you take from an excerpt, put that excerpt's number in square brackets, like [1] or [2]. " +
  "Use only the numbers of excerpts you actually used.";

export function numberedExcerpts(chunks) {
  return chunks.map((c, i) => `[${i + 1}] (from ${c.source})\n${c.content}`).join("\n\n---\n\n");
}

// The first line of a chunk is its "Page > Section" label when the chunker
// added one; otherwise fall back to the file name.
function sectionLabel(chunk) {
  const firstLine = chunk.content.split("\n")[0].trim();
  if (firstLine && firstLine.length <= 160 && !/[.!?:]$/.test(firstLine)) return firstLine;
  return chunk.source.split("/").pop().replace(/\.(md|txt)$/, "");
}

// The excerpts an answer cited, in the order of their numbers.
export function citedSources(answer, chunks) {
  const numbers = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return [...numbers]
    .filter((n) => n >= 1 && n <= chunks.length)
    .sort((a, b) => a - b)
    .map((n) => ({ n, source: chunks[n - 1].source, section: sectionLabel(chunks[n - 1]), text: chunks[n - 1].content }));
}
