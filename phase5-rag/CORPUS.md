# The document corpus

What the RAG pipeline ingests, where it came from, and what is and is not in git.

## Public documents: `docs/` (committed)

| Path | What | Size |
|---|---|---|
| `docs/sample.md`, `docs/equipment.md` | The two made-up sample documents from Phase 5 and 5.6. The older evals depend on them. | 2 files |
| `docs/handbook/` | The TTS Handbook, the employee handbook of the U.S. General Services Administration's Technology Transformation Services. | 241 pages, about 1.5 million characters |

### Source and licence of the handbook

- Source: https://github.com/18F/handbook, the `pages/` folder, at commit `c220f93` (2026-06-04).
- Copied unchanged, except that empty files were left out.
- Licence, quoted from the source repository's `LICENSE.md`: "As a work of the United States
  Government, this project is in the public domain within the United States. Additionally, we waive
  copyright and related rights in the work worldwide through the CC0 1.0 Universal public domain
  dedication."

It was chosen because it is a real organisation's handbook with a licence that allows copying, and
because it is messy in the way real documents are: YAML front matter, template tags such as
`{% page "..." %}`, raw HTML tables, long pages and tiny stub pages.

It is used here as test material only. Nothing in this project is affiliated with or endorsed by GSA.

## Private documents: `docs-private/` (NOT in git)

`.gitignore` excludes `phase5-rag/docs-private/`, so nothing in it is ever committed or pushed. Put
real confidential documents there. They are ingested on this machine like any other document, with
`private/` added to the front of their source name.

- The folder does not exist in a fresh clone. Create it when you need it; ingestion works without it.
- Test questions about private documents go in `docs-private/eval-cases.json`, not in the repo: a
  question and its expected answer reveal the content just as the document does.
- The database (Docker volume) and the trace log (`logs/`) hold private content after ingestion.
  Neither is in git.

## Loading the corpus

```bash
cd phase5-rag
node --env-file=.env ingest.js     # about 45 seconds for 2,340 chunks
```

`ingest.js` reads both folders at any depth and removes chunks for files that no longer exist.
`CHUNK_SIZE`, `CHUNK_OVERLAP` and `INGEST_TABLE` can be set in the environment for experiments.
