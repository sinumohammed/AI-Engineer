# Phase 5.6 — Hybrid Search: Study Notes (English + Malayalam)

Personal study notes to memorize/revise Phase 5.6. Each section: English first, Malayalam explanation below it.

---

## 0. Quick recap: Phase 1 → Phase 5.6 (where this fits)

| Phase | What it built |
|---|---|
| 1 | Ran a local model via Ollama (`qwen2.5-coder:7b-instruct-q4_K_M`) |
| 2 | Talked to it via plain Node.js code (no framework) |
| 3 | Built a minimal agent loop with tools (`list_files`, `read_file`, `get_current_time`) |
| 4 | Wrapped tools as an MCP server (the "production pattern") |
| 5 | RAG: chunk docs → embed → store in Postgres+pgvector → retrieve by vector distance |
| 5.5 | Combined agent: RAG became a tool (`search_company_docs`) inside the Phase 3 agent |
| 5.6 | **THIS PHASE** — fixed vector search's blind spot on exact codes/IDs, using hybrid search |
| 6–7 | UI, memory, Redis, token limits, summarization, evals, retries, config, tracing |
| 8 | Not started — framework comparison + multi-agent |

**Malayalam:** Phase 1-ൽ Ollama വഴി model run ചെയ്തു. Phase 2-ൽ code വഴി അതിനോട് സംസാരിച്ചു. Phase 3-ൽ tools ഉള്ള agent ഉണ്ടാക്കി. Phase 4-ൽ അതിനെ MCP ആയി wrap ചെയ്തു. Phase 5-ൽ RAG (docs → embeddings → Postgres/pgvector → vector search) ഉണ്ടാക്കി. Phase 5.5-ൽ RAG-യെ agent-ന്റെ ഒരു tool ആക്കി. **Phase 5.6 (ഈ document)** — vector search-ന്റെ ഒരു real limitation (exact codes/IDs confuse ചെയ്യുന്നത്) hybrid search വഴി fix ചെയ്തു. Phase 6-7 UI/reliability. Phase 8 ഇനി തുടങ്ങാനുള്ളത്.

---

## 1. The problem that started Phase 5.6

**English:** Pure vector search (Phase 5) turns text into embeddings (number vectors) and finds the "closest" chunk by meaning/topic similarity — not exact word/code matching. This was proven to fail on identifiers: a document said `"Equipment Model XJ-2200 requires calibration every 90 days."` Querying the *real* code (`XJ-2200`) gave distance `0.206`. Querying a *made-up* code (`XJ-9999`) gave distance `0.251` — both well under our relevance cutoff of `0.5`. So the system would have confidently answered about equipment XJ-2200 even when asked about a completely different, nonexistent code XJ-9999. Why: embeddings capture *topic* ("this is about equipment codes and calibration"), not precise digit-by-digit identity.

**Malayalam:** Pure vector search, text-നെ embeddings (number vectors) ആക്കി, meaning/topic അടിസ്ഥാനത്തിൽ ഏറ്റവും "അടുത്ത" chunk കണ്ടെത്തുന്നു — exact word/code match അല്ല ഇത് നോക്കുന്നത്. ഒരു doc-ൽ `"Equipment Model XJ-2200 requires calibration every 90 days."` എന്ന് ഉണ്ടായിരുന്നു. ശരിയായ code (`XJ-2200`) query ചെയ്താൽ distance `0.206`. **തെറ്റായ/ഇല്ലാത്ത** code (`XJ-9999`) query ചെയ്താൽ പോലും distance `0.251` — രണ്ടും `0.5` threshold-നു താഴെ! അതായത് system, ഇല്ലാത്ത XJ-9999-നെ കുറിച്ച് ചോദിച്ചാൽ പോലും, confident ആയി XJ-2200-യുടെ വിവരം കൊടുക്കും. കാരണം: embeddings "topic" പിടിക്കും ("ഇത് equipment code + calibration-നെ കുറിച്ചാണ്"), exact digit-by-digit identity അല്ല.

---

## 2. What already existed (before Phase 5.6)

**English:**
- `phase5-rag/schema.sql` → Postgres table `doc_chunks` with an `embedding vector(768)` column + HNSW index for fast cosine-distance search.
- `phase5-rag/tools.js` → `search_company_docs` ran ONE query: `SELECT ... embedding <=> $1 AS distance ORDER BY distance LIMIT 4`. This is the `<=>` cosine distance operator from pgvector.
- `phase5-rag/agent.js` / `phase6-ui/server/agent.js` → decided "is this relevant?" using ONE rule: `distance < RELEVANCE_THRESHOLD (0.5)`.

**Malayalam:**
- `schema.sql` → `doc_chunks` table, `embedding` column (768 numbers per chunk), fast search-നു HNSW index.
- `tools.js` → `search_company_docs`, ഒരു query മാത്രം run ചെയ്തിരുന്നു: vector distance അനുസരിച്ച് top 4 chunks.
- `agent.js` → "relevant ആണോ" എന്ന് ഒരു rule മാത്രം വച്ച് തീരുമാനിച്ചിരുന്നു: `distance < 0.5`.

---

## 3. What we added — the two "legs" of hybrid search

**English:** "Hybrid" means running TWO different search methods and combining them:

**Leg A — Vector search (already existed):** finds chunks close in *meaning*.

**Leg B — Keyword/full-text search (NEW):**
- Added a `content_tsv tsvector` column to `doc_chunks` (a Postgres full-text search index format), generated automatically from `content`, with a GIN index for speed.
- Added a second SQL query using `websearch_to_tsquery('english', $1)` — this finds chunks containing the exact words/phrases from the query.
- Key fact (tested directly in psql): Postgres lexes a hyphenated code like `XJ-2200` as a **phrase**: `'xj' <-> '-2200'` — meaning it only matches if "xj" is immediately followed by "-2200" in the text. This gives an exact-match signal vector search cannot give.

**Merging — Reciprocal Rank Fusion (RRF):** Both search legs return a *ranked list* (1st place, 2nd place, etc). RRF combines two ranked lists into one, by giving each item a score `1/(60 + its position)` from each list it appears in, then summing and re-sorting. A chunk that ranks well in BOTH lists rises to the top; one that appears in only one list still gets partial credit.

**Malayalam:** "Hybrid" എന്നാൽ **രണ്ട്** search methods run ചെയ്ത് combine ചെയ്യുക എന്നാണ്:

**Leg A — Vector search (already ഉണ്ടായിരുന്നത്):** meaning-അടിസ്ഥാനത്തിൽ അടുത്ത chunks കണ്ടെത്തുന്നു.

**Leg B — Keyword/full-text search (പുതുതായി ചേർത്തത്):**
- `doc_chunks`-ൽ `content_tsv` എന്ന column ചേർത്തു (Postgres-ന്റെ full-text search format), GIN index-ഓടെ.
- `websearch_to_tsquery` ഉപയോഗിച്ച് ഒരു രണ്ടാമത്തെ query ചേർത്തു — ഇത് query-ലെ exact words/phrases doc-ൽ ഉണ്ടോ എന്ന് നോക്കുന്നു.
- Important fact (psql-ൽ direct ആയി test ചെയ്തത്): "XJ-2200" പോലുള്ള hyphenated code-നെ Postgres ഒരു **phrase** ആയി കാണുന്നു — "xj" ഉടനെ "-2200" വരണം. ഇത് vector search-ന് തരാൻ പറ്റാത്ത ഒരു exact-match signal ആണ്.

**Merge — RRF:** രണ്ട് search-ഉം ranked lists (1st, 2nd, ...) തരും. RRF, ഇവ combine ചെയ്യുന്നു — ഓരോ list-ലും ഒരു item-ന്റെ position അനുസരിച്ച് ഒരു score (`1/(60+position)`) കൊടുത്ത്, രണ്ട് lists-ലെയും scores കൂട്ടി, വീണ്ടും sort ചെയ്യുന്നു. രണ്ട് lists-ലും top-ൽ ഉള്ള chunk ഏറ്റവും മുകളിൽ വരും.

---

## 4. The REAL fix — identifier mismatch check (not RRF!)

**English:** This is the piece that actually solves the original problem. Logic:
1. Extract any code-shaped token from the question using a regex: `[A-Za-z]{1,6}-?\d{2,6}` (letters, optional hyphen, digits) — e.g. matches "XJ-2200", "XJ-9999".
2. If the question has such a token AND vector search says a chunk is relevant (`distance < 0.5`)...
3. ...check: does that exact token literally appear (case-insensitive) inside that chunk's content?
4. If NOT → set `identifierMismatch = true`. The agent then answers: *"I don't have information about that specific identifier — I won't substitute a similar one."* instead of confidently (and wrongly) answering with XJ-2200's data.

**Important — honest caveat:** the RRF/keyword-merge leg (section 3) turned out to contribute very little in practice, because `websearch_to_tsquery` requires ALL words in the query to match (AND logic) — this caused Bug 1 (next section). The identifier-mismatch check is decoupled from that leg entirely and is what actually fixes the bug.

**Malayalam:** ഇതാണ് യഥാർത്ഥ problem fix ചെയ്യുന്ന ഭാഗം. Logic:
1. Question-ൽ ഒരു code-shaped token ഉണ്ടോ എന്ന് regex വച്ച് extract ചെയ്യുന്നു ("XJ-2200" പോലുള്ളവ).
2. അങ്ങനെ ഒരു token ഉണ്ട്, AND vector search "relevant" (`distance < 0.5`) എന്ന് പറയുന്നു എങ്കിൽ...
3. ...ആ exact token, ആ chunk-ന്റെ content-ൽ literal ആയി ഉണ്ടോ എന്ന് check ചെയ്യുന്നു.
4. ഇല്ലെങ്കിൽ → `identifierMismatch = true`. Agent പറയും: *"ആ specific identifier-നെ കുറിച്ച് വിവരമില്ല, similar-ഉള്ള മറ്റൊന്ന് guess ചെയ്യില്ല."*

**ശ്രദ്ധിക്കുക:** RRF/keyword leg practically വളരെ കുറച്ചേ contribute ചെയ്യുന്നുള്ളൂ (`websearch_to_tsquery`-ന്റെ "എല്ലാ വാക്കും വേണം" rule കാരണം) — ഇത് Bug 1-ന് കാരണമായി. Identifier-mismatch check, ആ leg-ൽ നിന്ന് completely decouple ചെയ്തതാണ്, അതാണ് real fix.

---

## 5. Bug 1 — "too strict a check rejected the CORRECT answer"

**English:**
- Doc content: `"...requires calibration every 90 days."` (note: the word **"schedule" is NOT in the doc**)
- Question asked: `"What is the calibration schedule for XJ-2200?"` (the word **"schedule" IS in the question**)
- **First (wrong) version of the mismatch check:** "If keyword search returns ZERO rows, treat it as a mismatch."
- `websearch_to_tsquery` ANDs every word: it required `calibration AND schedule AND (xj phrase -2200)` all present. Since the doc has no "schedule", the AND failed → keyword search returned 0 rows.
- Result: even for the CORRECT code (XJ-2200), the system said "0 keyword rows" → wrongly flagged `identifierMismatch = true` → wrongly answered "I don't have information," even though the correct doc was right there.
- **Fix:** stopped checking "did keyword search find anything" at all. Instead, directly check: does the literal string "XJ-2200" appear in the chunk's content? (ignore all other words in the question). This can never be broken by unrelated word-choice differences.

**Malayalam:**
- Doc-ൽ ഉള്ളത്: "...calibration every 90 days." (**"schedule" doc-ൽ ഇല്ല**)
- ചോദിച്ച ചോദ്യം: "calibration **schedule** for XJ-2200?" (**"schedule" question-ൽ ഉണ്ട്**)
- **ആദ്യത്തെ (തെറ്റായ) logic:** "Keyword search 0 results തന്നാൽ, mismatch എന്ന് കണക്കാക്കൂ."
- `websearch_to_tsquery`, question-ലെ **എല്ലാ** വാക്കും AND ചെയ്യുന്നു: calibration AND schedule AND XJ-2200 എല്ലാം വേണം. Doc-ൽ "schedule" ഇല്ലാത്തതുകൊണ്ട് AND fail ആയി → keyword search 0 rows തന്നു.
- Result: **ശരിയായ code (XJ-2200)**-ന് പോലും "0 keyword rows" വന്നു → തെറ്റായി `identifierMismatch = true` ആയി → ശരിയായ doc ഉണ്ടായിരുന്നിട്ടും "എനിക്ക് വിവരമില്ല" എന്ന് ഉത്തരം കൊടുത്തു.
- **Fix:** "keyword search എന്തെങ്കിലും കണ്ടെത്തിയോ" എന്ന check പൂർണ്ണമായി ഒഴിവാക്കി. പകരം: "XJ-2200" എന്ന exact string, chunk content-ൽ literal ആയി ഉണ്ടോ എന്ന് നേരിട്ട് check ചെയ്യുന്നു (question-ലെ ബാക്കി വാക്കുകൾ ignore ചെയ്ത്). ഇത് word-choice differences കൊണ്ട് ഒരിക്കലും തകരില്ല.

---

## 6. Bug 2 — "a missing number was silently treated as false" (latent bug, not yet triggered)

**English — the SQL order matters:**
```sql
SELECT ..., embedding <=> $1 AS distance
FROM doc_chunks
ORDER BY distance ASC
LIMIT 4
```
Postgres computes `distance` for every row FIRST, sorts by it, THEN keeps only the top 4 (`LIMIT 4`). So: distance calculation happens *before* the top-4 cut — but any row that gets cut by `LIMIT 4` never reaches our JavaScript code at all. Its distance was computed inside Postgres and then thrown away with the row.

**The bug:** After merging vector results + keyword results (RRF), the code checked relevance by reading `distance` off the **merged** list. A row that came ONLY from keyword search (not in the vector top-4) has no `distance` field on it — `undefined`. The comparison `undefined < 0.5` always evaluates to `false` in JavaScript. So a genuinely relevant chunk — found correctly by keyword search — would get silently marked "not relevant" and dropped.

**Why 2 docs didn't reveal it:** We only have 2 chunks total in the database. `LIMIT 4` asks for "top 4," but with only 2 chunks that exist, Postgres just returns both — nothing gets cut. So `vectorRows` always contains every chunk that exists, meaning any chunk keyword search finds is *already* in `vectorRows` too, complete with its `distance`. The specific condition needed to trigger the bug ("a chunk that keyword search found but vector search's top-4 did NOT include") is structurally impossible right now.

**How it would trigger with more docs:** Say there are 20 chunks. Vector search's top-4 might rank chunk #17 (the one with the exact code) in 7th place semantically — outside the top 4 — so it gets cut by `LIMIT 4` and never reaches our code with its `distance`. But keyword search, searching by exact phrase, finds chunk #17 directly (regardless of its semantic rank) and includes it. After merging, chunk #17 is in the list — but with no `distance` — and the old code would wrongly discard it as "not relevant," reintroducing the very hallucination hybrid search was built to prevent.

**Fix:** compute `bestVectorDistance` directly from the raw `vectorRows` (before merging), and gate relevance on that explicit field — never on `distance` read off the merged list.

**Malayalam — SQL order പ്രധാനമാണ്:**
```sql
... ORDER BY distance ASC LIMIT 4
```
Postgres, **എല്ലാ** rows-നും distance ആദ്യം calculate ചെയ്യുന്നു, sort ചെയ്യുന്നു, **അതിനുശേഷം** top 4 മാത്രം എടുക്കുന്നു. അതായത് distance calculation, top-4 cut-ന് **മുൻപ്** നടക്കുന്നു ശരിയാണ് — പക്ഷേ `LIMIT 4`-ന് പുറത്ത് പോയ row, നമ്മുടെ JavaScript code-ലേക്ക് ഒരിക്കലും വരില്ല. അതിന്റെ distance, Postgres-ന്റെ ഉള്ളിൽ calculate ചെയ്തിട്ട്, row-ഓടു കൂടെ discard ചെയ്യപ്പെടും.

**Bug:** Vector + keyword results merge (RRF) ചെയ്ത ശേഷം, relevance check ചെയ്തത് ആ **merged** list-ൽ നിന്ന് `distance` വായിച്ചാണ്. Keyword search മാത്രം കണ്ടെത്തിയ ഒരു row-ക്ക് (vector top-4-ൽ ഇല്ലാത്തത്) `distance` field **ഇല്ല** — `undefined`. JavaScript-ൽ `undefined < 0.5` എപ്പോഴും **false** ആണ്. അതുകൊണ്ട് ശരിക്കും relevant ആയ ഒരു chunk-നെ, keyword search ശരിയായി കണ്ടെത്തിയിട്ടും, silently "relevant അല്ല" എന്ന് തള്ളിക്കളയും.

**2 docs ഉള്ളപ്പോൾ ഇത് കാണാത്തത് എന്തുകൊണ്ട്:** ആകെ 2 chunks മാത്രമേ database-ൽ ഉള്ളൂ. `LIMIT 4` "top 4 വേണം" എന്ന് ചോദിക്കുന്നു, പക്ഷേ 2 മാത്രം ഉള്ളപ്പോൾ Postgres രണ്ടും തിരിച്ചു തരും — ഒന്നും cut ആകില്ല. അതുകൊണ്ട് `vectorRows`-ൽ database-ലുള്ള **എല്ലാ** chunks-ഉം ഉണ്ടാകും, distance-ഓടെ. Keyword search എന്ത് chunk കണ്ടെത്തിയാലും അത് already `vectorRows`-ൽ ഉണ്ട്. Bug trigger ആകാൻ വേണ്ട സാഹചര്യം ("keyword search മാത്രം കണ്ടെത്തിയ, vector top-4-ൽ ഇല്ലാത്ത chunk") ഇപ്പോൾ **ഉണ്ടാകാൻ സാധ്യതയേ ഇല്ല**.

**Docs കൂടിയാൽ ഇത് എങ്ങനെ trigger ആകും:** 20 chunks ഉണ്ടെന്ന് കരുതുക. Vector search-ന്റെ semantic ranking-ൽ, exact code ഉള്ള chunk#17, 7-ാം സ്ഥാനത്ത് ആയേക്കാം — top-4-ന് പുറത്ത്. `LIMIT 4` അതിനെ cut ചെയ്യും, distance നമ്മുടെ code-ലേക്ക് വരില്ല. പക്ഷേ keyword search, semantic rank നോക്കാതെ, exact phrase match ചെയ്ത് chunk#17-നെ കണ്ടെത്തും. Merge ചെയ്ത ശേഷം chunk#17 list-ൽ ഉണ്ട് — പക്ഷേ distance ഇല്ല — പഴയ code അതിനെ തെറ്റായി "relevant അല്ല" എന്ന് തള്ളിക്കളയും, hybrid search തടയാൻ ഉദ്ദേശിച്ച hallucination തന്നെ വീണ്ടും വരും.

**Fix:** `bestVectorDistance`, merge ചെയ്യുന്നതിന് മുൻപ്ത്തെ raw `vectorRows`-ൽ നിന്ന് നേരിട്ട് calculate ചെയ്ത്, ആ explicit field-ൽ relevance gate ചെയ്യുന്നു — merged list-ലെ `distance`-ൽ ഒരിക്കലും അല്ല.

---

## 7. Files touched (for reference)

| File | What changed |
|---|---|
| `phase5-rag/schema.sql` | Added `content_tsv` column + GIN index |
| `phase5-rag/tools.js` | `search_company_docs`: added keyword search, RRF merge, `identifierMismatch`, `bestVectorDistance`, `keywordHit` |
| `phase5-rag/agent.js` | Relevance gate now uses `bestVectorDistance`/`keywordHit`; 3-way prompt branch (relevant / mismatch / general) |
| `phase6-ui/server/agent.js` | Same changes as above (this is the copy the browser UI actually calls) |
| `phase5-rag/docs/equipment.md` | New permanent test doc: "Equipment Model XJ-2200... calibration every 90 days" |
| `phase7-reliability/eval.js` | 2 new regression cases (correct code / wrong code) — 7/7 passing |

**Malayalam:** മുകളിലെ table-ൽ ഓരോ file-ലും എന്ത് മാറ്റം വന്നു എന്ന് ചുരുക്കി കാണിച്ചിട്ടുണ്ട്. Commit: `70cc1c6`.

---

## 8. One-line summary to remember

**English:** *Vector search finds "similar meaning" but can't tell exact codes apart; we added keyword search + a direct substring check to catch that, and fixed two bugs along the way — one from being too strict, one from a missing number being silently treated as "no."*

**Malayalam:** *Vector search "similar meaning" കണ്ടെത്തും, പക്ഷേ exact codes distinguish ചെയ്യില്ല; അത് fix ചെയ്യാൻ keyword search + direct substring check ചേർത്തു, ഇടയിൽ 2 bugs (ഒന്ന് "too strict" ആയതുകൊണ്ട്, ഒന്ന് "missing number-നെ false ആയി കണ്ടതുകൊണ്ട്") fix ചെയ്തു.*
