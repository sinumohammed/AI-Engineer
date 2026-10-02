# Phase 9: RAG on real documents at real size

Everything before this phase was measured on two made-up documents: **2 chunks**. Search could not
miss, so retrieval quality had never been tested. This phase loads a real handbook and measures what
actually holds up.

Started 2026-10-02. Status: **step 9.1 done (corpus + baseline)**. Nothing has been improved yet;
this file records the starting point.

## Step 9.1: a real corpus and a baseline

### What was set up

| Piece | Where | Notes |
|---|---|---|
| Public corpus | `phase5-rag/docs/handbook/` | The TTS Handbook: 241 pages, about 1.5 million characters, public domain (CC0). Source and licence in `phase5-rag/CORPUS.md`. |
| Private documents | `phase5-rag/docs-private/` | Ignored by git, never pushed. Holds one made-up sample document for now. Ingested with a `private/` source prefix. |
| Ingestion | `phase5-rag/ingest.js` | Now reads sub-folders and both roots, takes chunk settings and the target table from the environment, and removes chunks of deleted files. The chunking itself is unchanged. |
| Retrieval eval | `phase9-real-docs/retrieval-eval.js`, `cases.js` | Tests search alone, with no model call. `npm run eval`. |

The corpus went from **2 chunks to 2,340 chunks** (244 files, ingested in about 45 seconds).

### How the retrieval eval works

Each case is a question plus `mustFind`: a short piece of text copied from the passage that answers
it. A case is a hit when a retrieved chunk contains that text, so it checks that search found the
answer, not just the right file. It reports the rank of that chunk:

- **hit@1**: the top result has the answer.
- **hit@4**: it is within the 4 chunks the agent is given.
- **hit@10**: search found it, but too low for the agent to see.
- **agent sees it**: the same check through the real `search_company_docs` tool (vector + keyword).

### Baseline results (chunk size 800, overlap 100, raw text)

| Group | Cases | hit@1 | hit@4 | hit@10 | Agent sees it |
|---|---|---|---|---|---|
| Direct wording | 20 | 7 | 17 | 20 | 18 |
| Paraphrased | 10 | 3 | 3 | 8 | 3 |
| Original sample docs | 3 | 2 | 2 | 2 | 3 |
| Private docs | 4 | 2 | 2 | 2 | 2 |

Off-topic questions (the documents do not answer them): **5 of 8 are treated as relevant**.

### What the baseline shows

1. **Paraphrased questions are the weak point.** Asked in the document's own words, the answer is in
   the agent's 4 chunks 17 times out of 20. Asked the way a person would ("Can I roll my unused
   vacation days into next year?"), 3 out of 10.
2. **The answer is usually found, just ranked too low.** For paraphrased questions, 8 of 10 answers
   are in the top 10 but only 3 are in the top 4. That is the case reranking is meant for.
3. **Hybrid search now earns its place.** "When does the on-call rotation hand off?" is not in the
   vector top 10 any more, yet the agent still sees it, because the keyword half finds it. Phase 5.6
   noted the keyword half "rarely contributes" at 2 chunks. At 2,340 it rescues 2 cases.
4. **The relevance threshold no longer separates relevant from irrelevant.**

   | Best-match distance | With 2 chunks | With 2,340 chunks |
   |---|---|---|
   | Questions the documents answer | 0.36 - 0.44 | 0.18 - 0.36 (when the top result is correct) |
   | Off-topic questions | 0.67 - 0.68 | 0.38 - 0.52 |

   With more documents there is always something vaguely close. `RELEVANCE_THRESHOLD = 0.5` now calls
   "How many minutes are there in a day?" (0.378) relevant.
5. **That breaks the single agent on general questions.** It injects the excerpt, sees it does not
   answer, and refuses. Checked directly on four general questions search calls relevant: one was
   answered, three were refused ("the company document excerpt does not contain…"), including the
   SQL and git questions it used to answer. The multi-agent supervisor is less affected, because its
   router sends those to `coding` or `general` before any excerpt is involved.

### Effect on the earlier evals

| Eval | Before (2 chunks) | After (2,340 chunks) |
|---|---|---|
| Single agent, 7 cases | 7/7 | 6/7, then 7/7 after one test was corrected |
| Supervisor routing, 24 cases | 24/24 | 23/24 |
| Supervisor two-part answers | 3/3 | 3/3 |
| Supervisor second-hand answers | 4/4 | 4/4 |

- **Corrected test:** "What is our database backup schedule?" assumed the documents say nothing about
  backups. The handbook does discuss backups in general, without a schedule. The agent's answer said
  so and invented nothing, so the test now accepts "the documents do not specify" and forbids an
  invented schedule.
- **Open regression:** "How do I list git tags, and how are rollbacks done?" now routes to
  `coding + coding`. The router is shown the single best excerpt for the whole message, and with the
  handbook loaded that excerpt is about git, so the rollback half gets no evidence. Left failing on
  purpose; it is a retrieval-evidence problem to fix in this phase, not to patch around.

## Next steps, in order

Each one changes one thing and is measured with `npm run eval` against this baseline.

1. **Clean the text before chunking:** strip front matter and template tags, which currently sit
   inside chunks as noise. Several top results today are the first chunk of a page, which begins
   with its front matter.
2. **Chunking experiments:** chunk size and overlap, and splitting on headings instead of every 800
   characters. `INGEST_TABLE` and `EVAL_TABLE` let variants sit side by side.
3. **Reranking:** fetch 10 or more candidates and re-order them, aimed at the "found but ranked too
   low" cases.
4. **Rethink the relevance gate:** a fixed distance threshold does not survive corpus growth.
5. **Router evidence per part**, to fix the open routing regression.
6. **Citations:** answers that name the document and section they came from.

## Files

| File | Purpose |
|---|---|
| `retrieval-eval.js` | The retrieval eval. `npm run eval`; `EVAL_TABLE=<table>` to test an experiment table |
| `cases.js` | Public test cases: direct, paraphrased, original, off-topic |
| `../phase5-rag/CORPUS.md` | Where the corpus came from, its licence, and what stays out of git |
| `../phase5-rag/docs-private/eval-cases.json` | Private test cases. Not in git |
