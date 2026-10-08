# Phase 10 - the chat app, made ready for free hosted services

A self-contained copy of the chat app. Phases 1-9 are **frozen** as the working
local reference; from Phase 10 on, only this folder changes. The plan is in
`../ROADMAP.md` under Phase 10.

## Layout

```
phase10-cloud/
├── .env        settings for everything below (gitignored; copy .env.example)
├── start.sh    one command: Docker, Postgres, Redis, API server, web UI
├── api/        the API server and everything it imports - one package.json
├── web/        the React app
├── scripts/    ingest.js - loads the handbook into Postgres
└── eval/       every eval, pointed at api/
```

## Where each file came from

| Copy | Original |
|---|---|
| `api/server.js`, `agent.js`, `multiAgent.js`, `sessionStore.js` | `phase6-ui/server/` |
| `api/config.js`, `tools.js`, `tracer.js`, `retry.js`, `retrieve.js`, `llmClient.js`, `summarize.js`, `citations.js` | `phase5-rag/` |
| `api/llm.js`, `routing.js`, `specialists.js`, `supervisor.js` | `phase8b-multi-agent/` |
| `scripts/ingest.js`, `cleanText.js`, `chunker.js`, `schema.sql` | `phase5-rag/` |
| `eval/single-agent-eval.js` | `phase7-reliability/eval.js` |
| `eval/supervisor-eval.js` | `phase8b-multi-agent/eval.js` |
| `eval/retrieval-eval.js`, `citation-eval.js`, `cases.js` | `phase9-real-docs/` |
| `web/` | `phase6-ui/web/` |

Not copied: the LangGraph supervisor, the Phase 8a LangChain agents and the
Phase 2-5 scripts - the chat app does not use them. The handbook is not copied
either: `scripts/ingest.js` reads it in place from `../phase5-rag/docs`.

Comments inside the copied files still name the original files. They record
where the code and its lessons came from.

## Run it

```bash
cp .env.example .env          # once
(cd api && npm install) && (cd web && npm install) && (cd scripts && npm install)   # once
./start.sh                    # then open http://localhost:5174
```

It runs next to the original app (API 3001, web 5173) on API 3002 and web
5174, against the same local Ollama, Postgres and Redis.

## Evals

From `eval/`:

| Command | What it checks |
|---|---|
| `npm run eval:retrieval` | search alone: is the answer passage found, and does the model's relevance judgement keep it |
| `npm run eval` | the single agent's regression cases |
| `npm run eval:regression:multi` | the same regression cases against the supervisor |
| `npm run eval:supervisor` | supervisor routing, two-part questions, history |
| `npm run eval:citations` | citations from the single agent |
| `npm run eval:citations:multi` | citations from the supervisor |

## Steps

### 10a.1 Copy without changing behaviour

The only changes from the originals are import paths (everything the server
needs is now a sibling file in `api/`), the ports (3002, 5174) and the
document folders `ingest.js` reads.

Result (2026-10-06, `qwen3-coder:30b` on local Ollama): every eval gives
exactly the Phase 9 end-state numbers, so the copy is faithful.

| Eval | Phase 9 end state | This copy |
|---|---|---|
| Retrieval, agent sees the answer: direct / paraphrased / original / private | 20/20, 7/10, 3/3, 4/4 | 20/20, 7/10, 3/3, 4/4 |
| Off-topic questions wrongly treated as relevant | 0/8 | 0/8 |
| Single agent regression | 7/7 | 7/7 |
| Same regression cases against the supervisor | 7/7 | 7/7 |
| Supervisor routing / two-part / history | 24/24, 3/3, 4/4 | 24/24, 3/3, 4/4 |
| Citations, single agent: cites a source / cites the expected passage / stray numbers | 37/37, 32/37, 0 | 37/37, 32/37, 0 |
| Citations, multi-agent | 37/37, 31/37, 0 | 37/37, 31/37, 0 |

All six evals together took about 8 minutes.

### 10a.2 Model provider setting

`LLM_PROVIDER` in `.env` picks where chat calls go: `ollama` (default),
`groq`, or `openai` for any other OpenAI-compatible API. Set `CHAT_MODEL` to a
model that provider has. Settings given on the command line win over `.env`,
so one run can switch without editing it:

```bash
LLM_PROVIDER=groq CHAT_MODEL=openai/gpt-oss-120b npm run eval
```

What changed:

- **One client for every model call** (`api/llmClient.js`). The single agent
  (`agent.js`) and the conversation summary (`summarize.js`) each had their
  own Ollama request; they now use the shared client like the reranker and
  the supervisor already did. The client speaks two formats, Ollama's
  `/api/chat` and OpenAI's `/chat/completions`, and returns the same shape
  from both. JSON schemas are sent in strict mode, with
  `additionalProperties: false` added by the client, so the router and
  relevance schemas are still written once. `tools` is sent only when the
  list is not empty (the agent's is).
- **Embeddings have their own URL** (`EMBED_BASE_URL`), still local Ollama:
  Groq has no embedding model. The chat key is never sent with them.
- **Rate limits** (`api/retry.js`): when a provider answers 429 with a
  `Retry-After` time, the request waits that long and tries again, up to 2
  minutes of waiting in total.
- **Plain characters** (`plainText` in `llmClient.js`): gpt-oss writes a narrow
  no-break space in "90 days", a non-breaking hyphen in "XJ-2200", and
  sometimes cites as 【1】. They look right on screen, but the citation parser
  found no sources in those answers and the evals failed correct answers.
  The client turns them into plain characters.
- **Eval phrasings** (`eval/single-agent-eval.js`): four new ways gpt-oss says
  a correct answer ("10 a.m.", "don't have any information", "don't have
  access to", "not aware of") are accepted. The "must not contain" checks are
  unchanged.
- **Summary call:** on Ollama it now sends `num_ctx` and `TEMPERATURE` like
  every other call; before, it used Ollama's default context window.

Groq, as checked on 2026-10-06 with this account: the chat models are
`openai/gpt-oss-120b`, `openai/gpt-oss-20b` and `qwen/qwen3.8-27b` (the Llama
models in the original plan are gone). All three accept strict JSON schemas.
Free limits per model: 1,000 requests a day and 8,000 tokens a minute
(`qwen/qwen3.8-27b` also only 1,000 output tokens a minute). One handbook
question costs about 3,500 tokens, so the evals spend much of their time
waiting for the per-minute limit.

Results:

| Run | Single agent | Supervisor regression | Routing / two-part / history | Citations |
|---|---|---|---|---|
| `ollama`, all six evals | 7/7 | 7/7 | 24/24, 3/3, 4/4 | same as step 1 (retrieval too) |
| `openai` format against Ollama's own `/v1` (same model) | 7/7 | 7/7 | 24/24, 3/3, 4/4 | - |
| `groq`, `openai/gpt-oss-120b`, first run | 3/7 | - | - | - |
| `groq`, after plain characters and eval phrasings | 7/7, 7/7 (two runs) | 7/7 | not run yet (step 5) | not run yet (step 5) |

The four first-run failures on Groq were all correct answers: 3 in words
the eval did not accept, 1 with a no-break space inside "90 days".
The full eval set on Groq is step 5.

### 10a.3 Settings instead of localhost

| Setting | Used by | Default |
|---|---|---|
| `DATABASE_URL` | search (`api/tools.js`), `scripts/ingest.js` | `postgres://rag:rag@localhost:5432/rag` |
| `REDIS_URL` | chat history (`api/sessionStore.js`) | `redis://localhost:6379` |
| `VITE_API_BASE` | the web app (`web/src/useChatSession.js`) | `http://localhost:3002`; empty = same site as the page |
| `TRACE_TO` | `api/tracer.js` | `console` on Vercel, `file` elsewhere |

- **One settings file.** The web app reads `phase10-cloud/.env` too
  (`envDir` in `web/vite.config.js`). Vite only passes `VITE_*` values to the
  browser: a production build was searched and contains no key.
- **The server says what it is using** when it starts - provider, model and
  hosts, never passwords:
  ```
  Phase 10 API listening on http://localhost:3002
    chat:       groq openai/gpt-oss-120b at https://api.groq.com/openai/v1
    embeddings: nomic-embed-text at http://localhost:11434
    documents:  postgres://localhost:5432/rag
    sessions:   redis://localhost:6379
    traces:     logs/traces.jsonl
  ```
- **Traces to the console** (`TRACE_TO=console`): the same JSON line, prefixed
  `[trace]`. A hosted function's files are gone after the request; its
  console output stays in the host's logs.

Found by testing the new settings with wrong values, fixed here because
Neon will cause the same failures:

| Test | Before | After |
|---|---|---|
| Wrong password in `DATABASE_URL` | search silently empty, the UI said "not relevant", nothing logged | `[search] document search failed: password authentication failed...` |
| The next question after a failed connection | failed too, until a restart: one `pg.Client` cannot connect twice | tries again (a `pg.Pool` opens connections as needed) |
| Postgres restarted while the server runs | **the server crashed** (unhandled error from the dropped connection) | logged as `[db] idle connection error`, the next questions use the documents again |

Neon suspends after 5 idle minutes and closes open connections - the
restart test is that situation.

Results on Ollama after this step: unchanged on all six evals (retrieval
20/20, 7/10, 3/3, 4/4, off-topic 0/8; single agent 7/7; supervisor
regression 7/7; routing 24/24, 3/3, 4/4; citations 37/37 with 32 and 31 on
the expected passage). The evals still exit by themselves with the pool.

### 10a.4 Embeddings without Ollama

Planned: Gemini embeddings. Done instead: the same nomic model running
inside the Node process (`EMBED_PROVIDER=local`), because Gemini's free tier
turned out too small.

**Shared code first.** `api/embed.js` is now the one place that embeds text,
for search and for `scripts/ingest.js` (each had its own copy). Settings:
`EMBED_PROVIDER=ollama | local | gemini`, `DOCS_TABLE` (the table search
reads). Also new:

- **Each table is labelled with its embedding model** (a Postgres table
  comment, written by ingest). Search and ingest refuse a mismatch: vectors
  from two models cannot be compared, and mixing them gives no error, only
  plausible wrong results. Tables from before Phase 10 count as Ollama's.
- **Private documents are ingested only when the text stays on this machine
  twice over:** embedded here (not by a hosted API) and stored here (not in
  Neon). Decided in code from the settings.
- **Ingest resumes:** a file whose chunks are already stored unchanged is
  not embedded again.

**Gemini (measured 2026-10-06).** `gemini-embedding-001` at 768 numbers
works, but the free tier counts every text, batched or not: **100 a minute
and 1,000 a day**. The handbook is 4,284 chunks, so about 4 days of quota,
shared with every question the hosted app embeds. The ingest stopped at 842
chunks on the daily limit (table `chunks_gemini`, incomplete; `EMBED_PROVIDER=gemini`
still works and the ingest continues where it stopped).

**The nomic model inside Node** (`@huggingface/transformers`,
`nomic-ai/nomic-embed-text-v1.5`):

| Precision | Model file | Same vectors as Ollama (cosine) | Fits a Vercel function (250 MB)? |
|---|---|---|---|
| fp32 | 547 MB | 1.0000 | no |
| fp16 | 274 MB | 1.0000 | no |
| **q8 (used)** | 137 MB | 0.96-0.97 | yes, with the 44 MB Linux runtime |

q8's vectors differ a little from Ollama's, so the documents were
re-embedded with q8 too: all 4,288 chunks in 2 min 17 s on the Mac, no
network, no quota (table `chunks_local_q8`). Loading the model takes 0.6 s,
each question 7 ms; the process uses about 340 MB.

| Eval | Phase 9 (Ollama nomic) | q8 in Node |
|---|---|---|
| Retrieval, agent sees the answer: direct / paraphrased / original / private | 20/20, 7/10, 3/3, 4/4 | 20/20, 7/10, 3/3, 4/4 |
| Retrieval top-1: direct / paraphrased | 17/20, 4/10 | 17/20, 3/10 |
| Off-topic wrongly relevant | 0/8 | 0/8 |
| Single agent | 7/7 | 7/7 |
| Citations: cites a source / the expected passage | 37/37, 32/37 | 37/37, 32/37 |

The agent reads the same excerpts in every group; one paraphrased answer
moved from first place to lower in the top 4. Not yet known, for step 6: the
first request on a new Vercel instance downloads the 137 MB model from
Hugging Face into `/tmp`, and the native ONNX runtime has to be included in
the function.

Ollama path after the refactor: retrieval and single agent unchanged.

### 10a.5 Neon and Upstash from the Mac (in progress)

**Neon** (Frankfurt, pooled connection): the public handbook only - 4,284
chunks, 0 private, 46 MB - in `chunks_local_q8`, loaded with:

```bash
cd scripts && DATABASE_URL="$(grep '^NEON_DATABASE_URL=' ../.env | cut -d= -f2-)" \
  EMBED_PROVIDER=local INGEST_TABLE=chunks_local_q8 npm run ingest
```

5 min 22 s. `scripts/ingest.js` now creates its table itself (a new database
has no `doc_chunks` to copy) and inserts one batch per file instead of one
row per chunk (each query is a ~120 ms round trip from Dubai). Private
documents are skipped because the database is not on this machine; the
evals skip their private cases in the same situation.

With documents from Neon and qwen on Ollama answering, every eval matches
the local q8 table: retrieval 20/20, 7/10, 3/3, off-topic 0/8; single agent
7/7; supervisor regression 7/7; routing 24/24, 3/3, 4/4; citations 33/33
cite a source (28 and 27 the expected passage, single and multi).

**Upstash:** the first database was created in Mumbai (`ap-south-1`) by
mistake and recreated in Frankfurt. Chat history is stored and read back.
A round trip from the Mac is ~245 ms for either database: both hostnames
resolve to the same Upstash entry points, so timing from here cannot show
the region - step 6 measures from Vercel.

**Found by hand on Groq: follow-up questions.** "And who is eligible for it?"
after an FMLA question got "I don't know". Search and relevance judging see
only the latest message, and "it" names nothing. qwen's judging had kept the
FMLA eligibility excerpt among four loose matches - right by luck; gpt-oss,
judging strictly, kept only the transit benefit. Now (`standaloneQuestion`
in `api/retrieve.js`) a message with a word that points back ("it", "that",
"they"...) is rewritten into a self-contained question before the search;
the model still answers the message as written. The pointing-word check is
in code: asked to rewrite every message, qwen turned "What is our rollback
process?" into a question about FMLA leave. New eval case; single agent
8/8 on Ollama (both tables) and on Groq, twice.

**Groq's third limit: 200,000 tokens a day per model.** On top of 1,000
requests a day and 8,000 tokens a minute. The retrieval eval on Groq used
most of it (direct 19/20 - "Where is the GSA bug bounty program run?" ranked
first by search but rejected by gpt-oss's judging; paraphrased 7/10;
original 3/3; off-topic 0/8) and the remaining evals stopped on the limit.
At ~3,500 tokens per handbook question, the free hosted app answers about
55 questions a day per model.

**Splitting the work between two models** (`JUDGE_MODEL`, default
`CHAT_MODEL`): relevance judging and follow-up rewriting are small decisions
that can use a smaller model with its own daily quota. Hosted setup:
answers on `openai/gpt-oss-120b`, `JUDGE_MODEL` and `ROUTER_MODEL` on
`openai/gpt-oss-20b`.

| Relevance judged by (documents in Neon) | Direct | Paraphrased | Original | Off-topic wrongly relevant |
|---|---|---|---|---|
| qwen3-coder:30b (Ollama) | 20/20 | 7/10 | 3/3 | 0/8 |
| openai/gpt-oss-120b | 19/20 | 7/10 | 3/3 | 0/8 |
| openai/gpt-oss-20b | 19/20 | 6/10 | 3/3 | 0/8 |

The direct miss is the same case for both gpt-oss models, and it is
variation, not a weaker judge: run again, 20b kept the expected excerpt.
The case itself is weak - "Where is the program run?" expects "GSA
administers a Bug Bounty Program", which says who rather than where.

**Next, in this order** (decided 2026-10-06):

1. Fewer tokens per question: `REASONING_EFFORT=low` and fewer judged
   candidates (12 → 8), measured with the retrieval eval before changing
   any default. gpt-oss's hidden reasoning counts against the daily quota.
2. When 120b's daily quota is used up, answer with 20b and say so in the UI.
3. When both are used up, a clear "try again in N minutes" message.
4. The remaining evals on Groq, spread over a day: single agent,
   supervisor regression, routing (20b), both citation evals.

How to run the hosted setup from the Mac (answers 120b, judging and routing
20b, documents in Neon, history in Upstash):

```bash
cd api && DATABASE_URL="$(grep '^NEON_DATABASE_URL=' ../.env | cut -d= -f2-)" \
  REDIS_URL="$(grep '^UPSTASH_REDIS_URL=' ../.env | cut -d= -f2-)" \
  EMBED_PROVIDER=local DOCS_TABLE=chunks_local_q8 \
  LLM_PROVIDER=groq CHAT_MODEL=openai/gpt-oss-120b \
  JUDGE_MODEL=openai/gpt-oss-20b ROUTER_MODEL=openai/gpt-oss-20b \
  NUM_CTX=131072 npm start
```

and `npm run dev` in `web/`. (`source .env` does not work: the Neon URL
contains `&`.)

**2026-10-07: items 1-3 done, item 4 partly.**

1. **Cheaper judging** (`eval/judge-cost.js`: score and tokens per question,
   all 41 public cases, `gpt-oss-20b` judging, documents in Neon):

   | Judging setting | Agent sees it (direct / paraphrased / original) | Off-topic wrongly relevant | Tokens per question |
   |---|---|---|---|
   | default effort, 12 candidates | 19/20, 6/10, 3/3 | 0/8 | 1,654 |
   | low effort, 12 candidates | 20/20, 8/10, 3/3 | 0/8 | 1,371 |
   | low effort, 8 candidates | 20/20, 8/10, 3/3 | 0/8 | 1,009 |

   `JUDGE_REASONING_EFFORT` (judging and follow-up rewrites only; answers
   keep their reasoning, not measured at low). Candidates: 8 scored the same
   on the q8 table for both models, but on the Ollama table one paraphrased
   answer is at rank 9, so the default is **10** - everything the retrieval
   eval counts as found.
   - The new follow-up case caught a trap: qwen's rewrite ("it" → "12 unpaid
     weeks of leave every 52 weeks under FMLA") moved the right section to
     rank 9. Now the model only names the referent and the code substitutes it.
   - The same case found an old router bug (also in Phase 9): it re-added the
     earlier question as a second part and sent both to `general`. Tasks
     repeating an earlier user message are dropped, the evidence search and
     the specialist use the resolved question.
2. **`FALLBACK_MODEL`**: when a model's daily quota is used up, the answer
   comes from the fallback and the UI shows a note.
3. **Clear limit message**: "Today's free limit for the AI model is used up
   - try again in about N minutes." Daily limits are not retried in place.
   The UI showed every server error as "connection error"; now the message.
   Items 2-3 were tested against a mock Groq server, directly and through
   the real server.

| Eval | Ollama (final code) | Groq: answers 120b, judging (low) and routing 20b, Neon |
|---|---|---|
| Retrieval: direct / paraphrased / original / private, off-topic | 20/20, 7/10, 3/3, 4/4, 0/8 | (judge-cost above) |
| Single agent | 8/8 | 8/8 |
| Supervisor regression | 8/8 | 8/8 |
| Routing / two-part / history | 24/24, 3/3, 4/4 | not run yet (daily limit) |
| Citations: cites a source / expected passage | 37/37, 32/37 | 13/13 run cases, then the daily limit |
| Citations, multi-agent | 37/37, 31/37 | not run yet |

On Groq the eval stopped with the new message, "Today's free limit for the
AI model is used up - try again in about 8 minutes" - item 3 on the real
service.

### 10b.6 Deployed on Vercel

| | URL | Vercel project |
|---|---|---|
| Web app | https://ai-engineer-web-seven.vercel.app | `ai-engineer-web` (`web/`, Vite) |
| API | https://ai-engineer-api-jet.vercel.app | `ai-engineer-api` (`api/`, Express as one function, Frankfurt) |

The access code is `HOSTED_ACCESS_CODE` in `.env` (the API's `ACCESS_CODE`
setting on Vercel); the web app asks for it once and remembers it.

**API settings on Vercel** (Production): `LLM_PROVIDER=groq`, `GROQ_API_KEY`,
`CHAT_MODEL=openai/gpt-oss-120b`, `JUDGE_MODEL`, `ROUTER_MODEL` and
`FALLBACK_MODEL` = `openai/gpt-oss-20b`, `JUDGE_REASONING_EFFORT=low`,
`EMBED_PROVIDER=local`, `DOCS_TABLE=chunks_local_q8`, `DATABASE_URL` (Neon,
`sslmode=verify-full`), `REDIS_URL` (Upstash), `ACCESS_CODE`,
`ALLOWED_ORIGIN` (the web app), `NUM_CTX=131072`, `TEMPERATURE=0`. Web:
`VITE_API_BASE` (the API). Deploy from each folder with
`npx vercel deploy --prod`.

**What deploying taught:**
- A project created with `vercel project add` has framework "Other": the
  first deploy built nothing and every route was Vercel's 404.
  `"framework": "express"` / `"vite"` in each `vercel.json` fixes it.
- `functions` in `vercel.json` only applies to files in an `api/` folder, not
  to an Express app; the deploy was rejected. Only `regions` is kept.
- The traced bundle is 188 MB (162 MB of it ONNX runtime binaries for five
  platforms), under the 250 MB limit. The 137 MB model is not in it: the
  first request on a new instance downloads it into `/tmp`.
- `x-vercel-id: bom1::fra1::...` - requests enter in Mumbai, the function
  runs in Frankfurt. A request that reads Redis three times takes no longer
  than one that does not (276 vs 278 ms from Dubai): Upstash really is in
  Frankfurt; the 245 ms measured from the Mac was the trip from Dubai.
- Postgres' "sslmode=require is treated as verify-full" warning appeared on
  every cold start; Vercel's `DATABASE_URL` says `verify-full` explicitly.
- The deployed bundle points at the API and contains no keys or hostnames.

**Measured through the public URL** (`npm run eval:public`, new: HTTP,
access code, answer stream, conversation in Upstash, a follow-up):
**12/12**, both modes. First question after a deploy (cold start, model
download included): 6-9 s. Single agent: 1-3 s per answer. Multi-agent:
2-19 s - three or four model calls per question meet Groq's 8,000 tokens a
minute. Access code: no code / wrong code → 401, right code → 200; CORS
names only the web app.

**2026-10-08: the remaining Groq evals** (answers 120b, judging and routing
20b, documents in Neon):

| Eval | Ollama (public cases) | Groq |
|---|---|---|
| Citations, single agent: from the documents / expected passage | 33/33, 28/33 | 32/33, **30/33** (direct 20/20) |
| Citations, multi-agent, direct questions | 20/20, 17/20 | **20/20, 20/20** - then the daily limit |
| Routing (router on 20b) | 24/24 | 18 passed, 2 failed, then a crash |

- The one single-agent case not answered from the documents ("Can journalists
  request what I write in chat?") is a search miss: the answer is not in the
  top 10. qwen's judge kept a loose match; gpt-oss judged that nothing
  answers it and said so.
- Routing on 20b failed the close-topic two-part question in both orders
  ("How are rollbacks done, and how do I list git tags?"), the case qwen
  needed the "list the parts first" rule for in Phase 8c.
- **The crash:** gpt-oss-20b wrote JSON that broke the router's schema (it
  put "reason" and "tasks" inside the "parts" list) and Groq answered 400
  `json_validate_failed` - its strict mode checks the output instead of
  forcing it, as Ollama does. In the deployed app that question would have
  shown an error. Now schema failures are retried, and if every attempt
  fails the caller gets empty content, which it already handles: the router
  falls back to a safe default, the judge to "nothing relevant". Tested on a
  mock Groq.
- The daily-limit message now names the model ("...the AI model
  (openai/gpt-oss-20b) is used up..."): without it neither the logs nor the
  user could tell which limit ran out.
- `ROUTING_ONLY=1 npm run eval:supervisor` runs only the 24 routing cases and
  reports the router's tokens per question (qwen: 24/24, ~660) - for the
  router comparison, 20b vs 120b, still to run: today's 20b quota ran out.

**Two-way fallback** (same day): with 20b's daily quota used up, every
question failed at the judging step - the fallback only covered 120b's
answers. `FALLBACK_MODEL` is now a list; on Vercel
`openai/gpt-oss-20b,openai/gpt-oss-120b`, so each model covers the other.
Tested on the mock (each direction, both out, the old single setting) and
live: with 20b out, "Who is eligible for FMLA?" was answered with the note
"openai/gpt-oss-120b stood in for openai/gpt-oss-20b".

**Small talk skips the search** (same day): "hi" still ran the document
search, the relevance judge and the router - about 1,000-2,000 free-tier
tokens for a greeting. `isSmallTalk` (`api/retrieve.js`) matches a message
that is only a greeting, thanks or a short acknowledgement; it goes straight
to a general answer (single agent: no search; multi-agent: no evidence search,
judge or router call). The match is on the whole message, so "hi, what is
our rollback process?" is searched as usual. Ollama: single 8/8, routing
24/24, supervisor regression 8/8.

**Rework requests and other languages** (same day, found on the deployed
app): after an FMLA answer, "tell that in malayalam" got "I don't have
information about that in the company documents". The follow-up rewrite made
it the search "tell FMLA in malayalam", nothing answered that, and the
company_docs specialist gave its fixed refusal - although the answer was
already in the conversation. `api/rework.js`: a message that only asks to
rework the previous answer (translate it, shorten it, simplify it, bullet
points...) is answered from the conversation with one model call - no
search, no routing. Matched on the whole message in code, only when there is
an earlier answer; "What is FMLA? Answer in Malayalam" still searches. The
reworked answer keeps the original's `fromCompanyDocs` tag (Phase 8c).
- Two new eval cases (shorter, French): single agent and supervisor 10/10 on
  Ollama. Malayalam is tested on Groq only: qwen on the Mac took over 5
  minutes and the request timed out.
- Live: Malayalam and Hindi rework, a new question with "answer in
  Malayalam", and a question written in Malayalam all answered correctly.
  gpt-oss once wrote a Hindi word in Cyrillic letters - a model slip.
