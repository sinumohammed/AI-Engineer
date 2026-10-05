// Phase 9.2: turn a source file into the text a reader would actually see,
// before it is chunked and embedded. The handbook is a website's source, so
// each page carries markup that means nothing to a reader but still lands in
// chunks and pulls their embeddings away from the content:
//   - YAML front matter (title, keywords, redirect lists, spell-check config)
//   - template tags: {% page "..." %}, {% slack_channel "..." %}, {% alert %},
//     whole {% comment %} blocks
//   - link URLs, often long Google Docs addresses
//   - raw HTML tags and entities
// The page title is kept separately: it is useful information, and step 9.3
// decides whether to attach it to chunks.
// Plain documents (like the original sample docs) pass through unchanged
// apart from whitespace.

export function cleanDocument(raw) {
  let text = raw.replace(/\r\n/g, "\n");
  let title = null;

  // YAML front matter: a block between two "---" lines at the very top.
  const frontMatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontMatter) {
    const titleLine = frontMatter[1].match(/^title:\s*(.+)$/m);
    if (titleLine) title = titleLine[1].trim().replace(/^["']|["']$/g, "");
    text = text.slice(frontMatter[0].length);
  }

  text = text
    // template comments are notes to editors - drop them with their contents
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    // a Slack channel reference reads as #channel-name on the rendered page
    .replace(/\{%-?\s*slack_channel\s+["']([^"']+)["']\s*-?%\}/g, "#$1")
    // every other template tag ({% page %}, {% alert %}, {% include %}...)
    .replace(/\{%[\s\S]*?%\}/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "")
    // images and links keep their visible text, lose the address
    .replace(/!\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, "$1")
    // heading anchors like {#handover-phase}
    .replace(/\s*\{#[^}]*\}/g, "")
    // HTML: line-level tags become line breaks, the rest just disappear
    .replace(/<\/?(p|div|br|tr|li|h[1-6]|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // tidy whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}
