# Phase 9: RAG on real documents at real size

Everything before this phase was measured on two made-up documents: **2 chunks**. Search could not
miss, so retrieval quality had never been tested. This phase loads a real handbook and measures what
actually holds up.

Started 2026-10-02, finished 2026-10-05. Status: **done**.

## Summary

| | Start of Phase 9 (raw text, 800-char chunks, distance threshold) | End of Phase 9 |
|---|---|---|
| Direct-wording questions: answer reaches the agent | 18/20 | 20/20 |
| Paraphrased questions: answer reaches the agent | 3/10 | 7/10 |
| Original sample docs | 3/3 | 3/3 |
| Private docs | 2/4 | 4/4 |
| Off-topic questions wrongly treated as relevant | 5/8 | 0/8 |
| Answers that cite their source | none (no citations) | 37/37 single agent, 37/37 multi-agent |
| Single-agent eval / supervisor routing | 7/7 → 6/7 / 23/24 at the new size | 7/7 / 24/24 |

What changed, in order: clean the text (9.2), cut at headings with a "Page > Section" label, use
nomic's task prefixes and 500-character chunks (9.3), let the model judge which candidates answer
the question instead of a distance threshold (9.4), and cite sources (9.6). Cost: the relevance
step adds one model call, about 1.7 seconds per question.

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

### Making the problem visible in the UI

In Single agent mode the chip always read `search_company_docs ✓`, because the search runs on every
question. It looked the same whether the answer used the documents or not, so the threshold problem
above could not be seen in the app. The chip now says what the search led to:

| Chip | Meaning |
|---|---|
| `search_company_docs · used` (green) | An excerpt was judged relevant and put in front of the model |
| `search_company_docs · not relevant` (grey) | The search ran; the model answered from its own knowledge |
| `search_company_docs · code not found` (grey) | The question named a code that no document contains |

Checked through the API: the rollback question shows `used`, "capital of France" shows
`not relevant`, XJ-9999 shows `code not found`, and "How do I list all git tags from the command
line?" shows `used` followed by a refusal - the threshold problem, now visible on screen.

## Step 9.2: clean the text before chunking

`phase5-rag/cleanText.js` turns a page into what a reader sees: front matter, template tags
(`{% page %}`, `{% slack_channel %}`, comment blocks), link addresses and HTML are removed; link text
and the page title are kept. 21% of the handbook's characters were markup.

| Measured on vector search alone | Raw | Cleaned |
|---|---|---|
| Direct: hit@1 / hit@4 / MRR | 7 / 17 / 0.58 | 14 / 18 / 0.79 |
| Paraphrased: hit@4 / MRR | 3 / 0.39 | 7 / 0.44 |

One regression showed the next problem: "What is the maximum salary at GSA?" fell out of the top 10,
because the shifted 800-character boundaries mixed its answer into a chunk about something else.

The eval's text matching was changed at the same time to compare text as a reader sees it (link
addresses and emphasis marks ignored), so raw and cleaned chunks are judged the same way. The
baseline numbers were re-run under the new matching and did not change.

## Step 9.3: chunk by structure

`phase5-rag/chunker.js` adds "sections" chunking: cut at headings, keep a section whole when it fits,
split long ones at paragraph breaks, merge tiny neighbouring sections. Optionally each chunk starts
with its location ("Family Medical Leave Act (FMLA) > About FMLA > Eligibility"). Also tested:
nomic-embed-text's task prefixes (`search_document:` / `search_query:`), which the model was trained
with and the pipeline had never used.

| Variant (all on cleaned text) | Direct hit@1 / hit@4 / MRR | Paraphrased hit@4 / MRR | Original | Private |
|---|---|---|---|---|
| Fixed 800 | 14 / 18 / 0.79 | 7 / 0.44 | 2/3 | 2/4 |
| Sections 800 | 13 / 19 / 0.79 | 4 / 0.38 | 3/3 | 2/4 |
| Sections 800 + location label | 15 / 20 / 0.87 | 5 / 0.37 | 2/3 | 2/4 |
| Sections 800 + label + prefixes | 16 / 20 / 0.89 | 6 / 0.51 | 3/3 | 2/4 |
| **Sections 500 + label + prefixes** | **17 / 20 / 0.93** | **7 / 0.54** | **3/3** | **4/4** |
| Sections 1200 + label + prefixes | 15 / 20 / 0.86 | 5 / 0.40 | 3/3 | 2/4 |

The bold row is now the default in `ingest.js` (4,288 chunks). The paraphrased group has only 10
questions, so differences of one or two between rows are within noise; the direct, original and
private groups moved together, which is why 500 was chosen. With 500-character chunks the agent
reads about 2,000 characters of context instead of 3,200.

Side effect on the older evals: supervisor routing went back to 24/24 (the open regression from 9.1
was a retrieval-evidence problem, and better retrieval fixed it, so the planned "router evidence per
part" step was not needed). The single agent dropped to 3/7: two answers said "re-deploy" instead of
"re-deploying" and one said "not explicitly stated" (the eval now accepts those wordings), and one
was real: "What is the capital of France?" was refused, because with the new distances off-topic
questions score 0.30-0.51, under the 0.5 threshold.

## Step 9.4: replace the distance threshold with a relevance judgement

`phase5-rag/retrieve.js` is now the one retrieval step every agent uses. It fetches 12 candidates
(vector + keyword) and asks the model which of them answer the question, best first. An empty list
means the documents do not answer it. That one call is both the relevance gate (replacing
`RELEVANCE_THRESHOLD`) and a reranker. The Phase 5.6 identifier check stays in code.

| | Distance threshold 0.5 | Model judgement |
|---|---|---|
| Direct: answer reaches the agent | 20/20 | 20/20 |
| Paraphrased: answer reaches the agent | 7/10 | 7/10 |
| Off-topic treated as relevant | 7/8 | 0/8 |
| Time for the retrieval step | 26 ms | about 1,700 ms |

The first wording of the judging prompt still let 1/8 off-topic questions through ("How many minutes
are there in a day?" matched an excerpt about 15-minute breaks), and later two routing cases too. The
final wording asks it to "judge strictly: include an excerpt only if someone could answer the question
from that excerpt alone". That fixed all of them and cost one paraphrased question ("Do the extra hours
I banked instead of overtime pay ever run out?" - the answer is ranked 2nd, but the judge rejects it).

## Step 9.5: router evidence per part - not needed

Planned to fix the 9.1 routing regression. Better retrieval in 9.3 fixed it, and the routing eval has
stayed at 24/24, so this was not built.

## Step 9.6: citations

`phase5-rag/citations.js`: the excerpts given to the model are numbered, the model puts the number
after each fact it uses ("...12 weeks of paid time off [1]"), and the code turns the numbers it used
into a source list ("Leave types > Annual leave · handbook/travel-and-leave/leave.md"). The chat UI
shows it under the answer. `npm run eval:citations` (single agent) and `eval:citations:multi` check it:

| | Single agent | Multi-agent |
|---|---|---|
| Answers that used the documents and cited a source | 37/37 | 37/37 |
| A cited excerpt contains the expected passage | 32/37 | 31/37 |
| Answers citing a number that does not exist | 0/37 | 0/37 |

The cited-but-not-expected cases that were inspected cite a different passage that also answers the
question (for example "within one hour of becoming aware of it" instead of the expected sentence).

### A multi-agent routing problem found by the citation eval

At first only 34/37 multi-agent answers used the documents: "Who is eligible for FMLA?", "How many
weeks of unpaid leave does FMLA entitle me to?" and "Should git commits be cryptographically signed?"
went to `general` and `coding`, which answered from general knowledge - plausible, and wrong for this
employer (general FMLA rules differ from the handbook's "at least one year of federal service").

- **A stronger router instruction** ("the company's own documents take priority") changed none of the
  three decisions.
- **A rule in code** (`applyDocPriority` in `routing.js`): for a one-part message, if the retrieval step
  judged the documents as answering it, `company_docs` answers it. This fixed the three - and broke two
  routing cases, because the judging prompt at the time wrongly accepted loosely related excerpts.
- **The stricter judging prompt** (9.4) fixed those two. With both changes: routing 24/24, all 37
  answers use the documents, 0/8 off-topic questions treated as relevant.

## Not done

- `phase8-framework/agent-a.js`, `phase5-rag/agent.js` and `phase5-rag/query.js` (earlier phases'
  scripts) still use the old distance threshold; the chat app and both supervisors use `retrieve.js`.
- With two `company_docs` tasks in one message, their citation numbers can overlap.
- The running summary of old turns is still not redacted (Phase 8c gap).

## Files

| File | Purpose |
|---|---|
| `retrieval-eval.js` | The retrieval eval. `npm run eval`; `EVAL_TABLE=<table>` to test an experiment table; `RERANK=0` for the old threshold |
| `citation-eval.js` | Citation checks. `npm run eval:citations`, `npm run eval:citations:multi` |
| `../phase5-rag/cleanText.js`, `chunker.js` | Cleaning and chunking (9.2, 9.3) |
| `../phase5-rag/retrieve.js` | Search + model-judged relevance, used by every agent (9.4) |
| `../phase5-rag/citations.js` | Numbered excerpts and cited sources (9.6) |
| `../phase5-rag/llmClient.js` | The shared plain model call |
| `cases.js` | Public test cases: direct, paraphrased, original, off-topic |
| `../phase5-rag/CORPUS.md` | Where the corpus came from, its licence, and what stays out of git |
| `../phase5-rag/docs-private/eval-cases.json` | Private test cases. Not in git |
