// Phase 9.3: how a document is cut into chunks.
//
// "fixed" is the Phase 5 chunker: every CHUNK_SIZE characters, with overlap,
// wherever that lands - mid-sentence, mid-list, across two unrelated sections.
// Step 9.2 showed the cost: cleaning the text shifted every boundary, and the
// passage answering "What is the maximum salary at GSA?" ended up in a chunk
// that no longer ranked in the top 10.
//
// "sections" follows the document's own structure instead: it cuts at
// markdown headings, keeps a section whole when it fits, and splits a long
// section at paragraph breaks. With `header`, every chunk starts with where it
// came from ("Leave types > Annual leave > Use or Lose"), so a chunk about
// "the 240-hour cap" still says it is about annual leave even when the
// heading was three paragraphs earlier.

export function chunkFixed(text, { size, overlap }) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

// Split a section's body into pieces of at most `size` characters, at
// paragraph breaks where possible. A single paragraph longer than `size`
// falls back to the fixed chunker.
function splitBody(body, { size, overlap }) {
  const pieces = [];
  let current = "";
  for (const paragraph of body.split(/\n{2,}/)) {
    if (!paragraph.trim()) continue;
    if (paragraph.length > size) {
      if (current) pieces.push(current);
      current = "";
      pieces.push(...chunkFixed(paragraph, { size, overlap }));
      continue;
    }
    if (current && current.length + 2 + paragraph.length > size) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) pieces.push(current);
  return pieces;
}

export function chunkSections(text, { title, size, overlap, header }) {
  // Walk the lines, tracking the heading path ("H1 > H2 > H3").
  const sections = [];
  const path = [];
  let body = [];
  const flush = () => {
    const joined = body.join("\n").trim();
    if (joined) sections.push({ path: [...path], body: joined });
    body = [];
  };
  for (const line of text.split("\n")) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      flush();
      const level = heading[1].length;
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = heading[2];
      // a skipped level (# then ###) leaves an empty slot - drop it
      for (let i = 0; i < path.length; i++) if (path[i] === undefined) path[i] = "";
    } else {
      body.push(line);
    }
  }
  flush();

  // Small neighbouring sections under the same parent are merged, so a
  // page of one-line sections does not become dozens of tiny chunks.
  const merged = [];
  for (const s of sections) {
    const prev = merged.at(-1);
    const sameParent = prev && prev.path.slice(0, -1).join(">") === s.path.slice(0, -1).join(">");
    if (prev && sameParent && prev.body.length + s.body.length + 50 <= size) {
      prev.body += `\n\n${s.path.at(-1) ?? ""}\n${s.body}`;
    } else {
      merged.push({ path: s.path, body: s.body });
    }
  }

  const pageTitle = title ?? null;
  const chunks = [];
  for (const s of merged) {
    const crumbs = [pageTitle, ...s.path].filter(Boolean);
    // drop a heading that only repeats the page title
    const trail = crumbs.filter((c, i) => i === 0 || c !== crumbs[i - 1]).join(" > ");
    const room = header && trail ? size - trail.length - 2 : size;
    for (const piece of splitBody(s.body, { size: Math.max(200, room), overlap })) {
      chunks.push(header && trail ? `${trail}\n\n${piece}` : s.path.length ? `${s.path.at(-1)}\n\n${piece}` : piece);
    }
  }
  return chunks;
}
