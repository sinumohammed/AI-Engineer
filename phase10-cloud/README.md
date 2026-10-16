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
├── eval/       every eval, pointed at api/
├── examples/   ask-client.js - how another app calls POST /api/ask
├── apps/       connected-app entries and how an app makes itself connectable (10d.4)
└── docs-internal/  internal business documents (gitignored; see 10d.3)
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

## Keys at a glance

Every secret, where it lives, and which way it goes. Values are in `.env`
(gitignored, each key commented) and in the hosts' settings - never in git.

```
web chat user --(HOSTED_ACCESS_CODE)--> AI service <--(ADMIN_KEY)-- you: npm run app
eval scripts  --(ASK_API_KEY = "eval")--> AI service
masjid server --(AI_ASK_KEY = "masjid")--> AI service --(MASJID_AI_TOKEN)--> masjid /api/ai/*
                                           AI service --(GROQ_API_KEY, GEMINI_API_KEY)--> models
```

| Key | For | In `.env` as | On Vercel (ai-engineer-api) | On Render (masjid backend) | New one |
|---|---|---|---|---|---|
| Groq | answer, judge, router models; Whisper | `GROQ_API_KEY` | `GROQ_API_KEY` | - | console.groq.com |
| Gemini | voice, photos/scans, overviews | `GEMINI_API_KEY` | `GEMINI_API_KEY` | - | aistudio.google.com |
| Neon | handbook vectors | `NEON_DATABASE_URL` | `DATABASE_URL` | - | Neon console |
| Upstash | history, attachments, app registry | `UPSTASH_REDIS_URL` | `REDIS_URL` | - | Upstash console |
| Web chat access code | everyone using the live chat | `HOSTED_ACCESS_CODE` | `ACCESS_CODE` | - | any string |
| eval app key | `/api/ask` tests and example client | `ASK_API_KEY` | `eval=...` in `APP_API_KEYS` | - | `npm run new-app-key -- eval` |
| masjid app key | the masjid server asking the AI | - | `masjid=...` in `APP_API_KEYS` | `AI_ASK_KEY` (+ `AI_ASK_URL`) | `npm run new-app-key -- masjid` |
| Admin key | `npm run app` (connected apps) | `ADMIN_KEY` | `ADMIN_KEY` | - | `npm run app -- keys` |
| App secrets key | encrypts app tokens in Redis | `APP_SECRETS_KEY` | `APP_SECRETS_KEY` | - | `npm run app -- keys` (then re-add every app) |
| Masjid AI token | the AI service reading masjid `/api/ai/*` | `MASJID_AI_TOKEN` | - (stored encrypted in the registry) | `MASJID_AI_TOKEN` | random 32 bytes, then `npm run app -- add ../apps/masjid.json` |

`APP_API_KEYS` on Vercel holds every `/api/ask` app: `eval=...,masjid=...`.
A changed Vercel value applies after the next `npx vercel deploy --prod`.

## Evals

From `eval/`:

| Command | What it checks |
|---|---|
| `npm run eval:retrieval` | search alone: is the answer passage found, and does the model's relevance judgement keep it |
| `npm run eval` | the single agent's regression cases |
| `npm run eval:regression:multi` | the same regression cases against the supervisor |
| `npm run eval:supervisor` | supervisor routing, two-part questions, history |
| `npm run eval:citations` | citations from the single agent |
| `npm run eval:citations:multi` | citations from the supervisor (`GROUPS=paraphrased,original` runs some groups only) |
| `npm run eval:multilingual` | the same handbook facts asked in Malayalam, Hindi and Spanish, plus off-topic questions |
| `npm run eval:reply-language` | is the answer in the question's language (`ONLY=Malayalam`, `MODES=multi` to save Groq quota) |
| `npm run eval:judge` | relevance judging: tokens per question and quality |
| `npm run eval:public` | the deployed app, through its public URL (needs `HOSTED_ACCESS_CODE`) |
| `npm run eval:long-file` | a 59-page PDF attachment: does the right page reach the prompt, which later questions get the file; `ANSWERS=1` also asks the agent (`AGENT=multi` for the supervisor) |
| `npm run eval:apps` | connected apps (10d.4) against the demo app: registration, safety; `ANSWERS=1` planner and answers (`MODES=`, `ONLY=`) |
| `npm run eval:masjid` | the masjid app end to end on this Mac with made-up data: starts its backend from `MASJID_REPO` (default `~/Code/Developer/work/MasjidRahma`) on a throwaway database and this API beside it; tokens and roles, limit settings, answers as admin / member / guest, isolation, daily limits (34 checks; `VOICE=1` adds voice). Never touches the live database |
| `npm run eval:policy` | the data policy (10d.3): confidential chunks only reach a local model, what ingest takes, Gemini for files - no model calls |
| `npm run eval:ask` | `POST /api/ask` for other apps: keys, bad requests, a question, a conversation (needs `ASK_API_KEY`; `API_URL=http://localhost:3002` for the Mac) |

`eval:supervisor` takes `ROUTING_ONLY=1` (routing cases only) or `SKIP_ROUTING=1`.
Sample files for attachments and voice input are in `eval/samples/` (see its README).

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

### 10a.5 Neon and Upstash from the Mac

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

### 10b.7 After the deploy: features for daily use (2026-10-08 to 2026-10-10)

All deployed. Details and measurements in `ROADMAP.md` (Phase 10) and the learning guide (rows 10b.7-10b.13).

| Feature | Where | Settings |
|---|---|---|
| Two-way model fallback, small talk without search, rework requests ("translate that") | `llmClient.js`, `retrieve.js`, `rework.js` | `FALLBACK_MODEL` (a list) |
| Per-part document check for two-part questions | `routing.js` (`applyDocPriority`) | `DOC_PRIORITY=0` to compare |
| Questions in other languages searched in English | `retrieve.js` | `TRANSLATE_SEARCH=0` to compare |
| Reply in the question's language (non-English messages only) | `replyLanguage.js` | `REPLY_LANGUAGE=0` to compare |
| New web UI: Ant Design X, phone/tablet/desktop layouts, dark mode, installable (PWA) | `web/src/`, `web/vite.config.js` | icons from `web/public/logo.svg`: `npx pwa-assets-generator` |
| Voice input: `POST /api/transcribe` (raw audio, `?lang=` hint) | `transcribe.js`, `web/src/useVoiceInput.js` | `GEMINI_API_KEY` (Gemini writes the text), `GEMINI_TRANSCRIBE_MODEL`; Groq Whisper as backup: `TRANSCRIBE_MODEL` |
| Message timestamps | `sessionStore.js` (`at` on each turn), `web/src/time.js` | - |
| Attachments, step 1: `POST /api/attachments?sessionId=` (raw file, `x-file-name` header), `DELETE` to remove | `attachments.js`, `gemini.js`, the `attachment` specialist | `GEMINI_API_KEY` for photos and scanned PDFs, `GEMINI_VISION_MODEL` |

Attachments: one file per chat (a new one replaces it); the file goes with the
message it was attached to, then only with follow-ups that look related. A file
whose text fits ~12,000 characters goes into the prompt whole; a longer one is
searched per question (step 10d.2).


### 10d.1 JSON `/api/ask` for other apps (2026-10-13)

Other apps ask the same agent with one JSON request and get one JSON answer -
no stream, no web UI. Each app has its own key instead of the access code.

```bash
curl https://ai-engineer-api-jet.vercel.app/api/ask \
  -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
  -d '{"question": "What is our rollback process?"}'
```

```json
{ "answer": "...[1]", "sources": [{ "n": 1, "source": "...", "section": "...", "text": "..." }],
  "fromCompanyDocs": true, "notices": [], "usage": { ... }, "conversationId": null, "mode": "single" }
```

| Field | |
|---|---|
| `question` | required, up to 4,000 characters |
| `conversationId` | optional; the same id remembers earlier questions (24 hours), as a chat does. Without it every question stands alone |
| `mode` | `"single"` (default) or `"multi"` (the supervisor) |
| `agent` | multi only: skip the router, e.g. `"coding"` |

`DELETE /api/ask/conversations/<id>` forgets a conversation. Errors are JSON
`{ "error": "..." }`: 400 bad request, 401 missing or unknown key, 429 the app's
daily limit or the model's free quota, 500 anything else.

| Part | Where | Settings |
|---|---|---|
| Keys, request checks, the answer | `api/askApi.js` (mounted before the access-code check in `server.js`) | `APP_API_KEYS=crm=ak_...,billing=ak_...` |
| New key | `api/newAppKey.js` - `npm run new-app-key -- crm` | prints the key once; nothing is stored |
| Daily limit per app | `sessionStore.js` (`countAppQuestion`, Redis `app:<name>:asks:<day>`) | `APP_DAILY_LIMIT` (default 100) |

- **One key per app**, so one app can be cut off (remove its entry, redeploy)
  without touching the others. Keys are compared timing-safe, like the access code.
- **Conversations are kept per app** (`session:app:<name>:<id>`): the same
  `conversationId` from two apps is two conversations, and an app cannot open
  the web app's chats.
- **A daily limit per app**, because every app spends the same free Groq quota
  as the web app - a looping app should not break the chat for everyone.
- No `APP_API_KEYS`: open on the Mac (as `local`), off when `ACCESS_CODE` is set.
- Not in this step: attachments and streaming through `/api/ask`.

**Using it from another app:** `examples/ask-client.js` is the code to copy into
that app's backend - one `fetch`, no dependencies. Try it from `examples/` with
`ASK_API_KEY` in `.env`: `npm run ask -- "What is our rollback process?"` (one
question), or `npm run ask` alone for a conversation (empty line to stop;
`MODE=multi`, `API_URL=http://localhost:3002` for the Mac). Call it from a
server, never from browser code - the key would be visible to anyone, and the
API only accepts browser calls from the web app's own site anyway. Use one
`conversationId` per user of that app.

Tested on the Mac (Ollama): `eval:ask` 9/9; plus by hand: another app's key with
the same `conversationId` did not see the first app's question; `mode: "multi"`
answered with sources; `APP_DAILY_LIMIT=1` gave 429 on the second question; with
`ACCESS_CODE` set, the access code does not open `/api/ask` and an app key does
not open the web app's routes. Live (Groq): `eval:ask` 9/9 - a cold start ~6 s,
then ~1.4 s a question.

### 10d.2 Long attachments (2026-10-14)

Step 1 put a file's whole text in the prompt, cut at ~12,000 characters - about
3 pages of a dense PDF, because Groq's free tier allows 8,000 tokens a minute.
Now a longer file is searched per question, like the handbook but inside the
function (`api/fileSearch.js`):

```
upload:    pages -> chunks of ~1,200 characters (never across a page, so each has one page number)
           -> one vector per chunk (the handbook's embedding model, embed.js) -> Redis, with the chat
           + a short overview by Gemini (what the file is, its parts with page numbers)
question:  the question's vector against every chunk + exact words and figures ("$1 million", "6.2%")
           -> the best 4 chunks, in page order -> one excerpt: overview + those pages
```

| Part | Where | Notes |
|---|---|---|
| Chunks, vectors, search | `fileSearch.js` | in-process cosine + keyword match, merged by rank (RRF) as in `tools.js`; vectors stored as int8 (768 bytes a chunk) |
| Long or short | `attachments.js` (`readAttachment`, `attachmentChunk`) | under ~12,000 characters: unchanged (whole text); text PDFs and long scans (Gemini's transcript, split at its page lines) |
| Overview | `attachments.js` (`overviewOf`) | Gemini, the first 1,500 characters of each page, 20 s a try, 2 tries; without Gemini, the start of page 1 |
| Which later questions get the file | `fileSearch.js` (`sharesTopicWords`) | two of the file's topic words (on 5%+ of its chunks) in one chunk |
| Search words in the supervisor | `specialists.js` (attachment) | the user's own message, not the router's rewording |

Limits: at most 400 chunks (~480,000 characters, ~100 dense pages); past that,
the later pages are not read and the chip says so. Upload is the existing 4 MB.

**Measured** (`npm run eval:long-file`, IRS Publication 15, 59 pages, 312 chunks):

| | Result |
|---|---|
| Fact on the right page reaches the prompt | 8/8 (step 1: 4/8, only facts repeated in "What's New" on page 2) |
| Later questions: 6 handbook/general ones without the file, 3 tax ones with it | 9/9 |
| Answers on the Mac (qwen3-coder), single agent / supervisor | 8/8 / 8/8 |
| Prompt size for the file | ~1,260 tokens (step 1: up to ~3,000) |
| Upload, Mac (Ollama embeddings) | ~20-23 s; 660 KB kept in Redis |
| Regression evals on the Mac (single, supervisor) | 10/10, 10/10 |
| **Live** (Vercel, Groq): upload of the 59-page PDF | **95 s** (in-process q8 embeddings on Vercel's CPU, ~4x the Mac); 660 KB saved in Upstash |
| **Live**: Medicare threshold, FUTA follow-up, $100,000 rule (multi), rollback without the file | 4/4 right, pages cited (30; 44; 33-35); `eval:public` 12/12 |

Found while building it, each first reproduced:
- "Any two words of the question in the file" sent every question to a 59-page
  file. Rare words only (on <15% of chunks) missed "What is the social security
  wage base?"; any two words in one chunk let in "How much paid parental leave
  do I get?". Two topic words in one chunk got all 9 right.
- The supervisor's router splits and rewords questions. The attachment
  specialist searched with "On how much of each employee's wages?" (FUTA
  dropped) and "This document explains when to start withholding Additional
  Medicare Tax." (the page with $200,000 dropped out): 5/8. Searching with the
  user's own message: 8/8.
- Gemini answered 503 "high demand" all day (2026-10-14). With the whole
  300,000 characters and retries, one upload waited 273 s, near Vercel's 300 s
  limit. Now only the start of each page goes to Gemini, with a 20 s limit per
  try, and the upload goes on without it.
- Live, Gemini timed out on every try (also a plain "Say OK."), so the overview
  was the start of page 1; the answers did not need it. While Gemini is down,
  photos and scanned PDFs cannot be read either.
- 95 s is long to wait, and 400 chunks (the cap) would be ~2 minutes - under
  Vercel's 300 s, but a next step could cut it: fewer, larger chunks, or
  embedding in the background while the chat goes on.
- Not from this step, fixed right after it (2026-10-14): with the short travel
  policy and no handbook excerpt, qwen cited "[3]" - the PDF's heading "3.
  Hotels" - instead of [1], so no source was listed, 3 runs out of 3, before
  and after 10d.2. The prompt already said heading numbers are not excerpt
  numbers. Now `fixFileCitations` (citations.js) turns a number that matches
  no excerpt into the file's, when a file is attached: only the file has
  numbered headings of its own. 0/3 to 3/3 in both modes (`ANSWERS=1 npm run
  eval:long-file`, part 4); the same file cited by two parts of a split
  question is listed once. Citation eval unchanged: 37/37, 32/37, 0.

### 10d.3 Real documents: which may go where (2026-10-14)

Before real documents are added, a rule for which ones may go to the hosted
services. Decided with the user; enforced in code (`api/dataPolicy.js`), from
the settings - a wrong `.env` cannot send a confidential file anywhere.

| Level | Folder (none of the non-public ones in git) | Stored in | Read by |
|---|---|---|---|
| public | `phase5-rag/docs` | any database (Neon too) | any model |
| internal | `phase10-cloud/docs-internal`, source prefix `internal/` | any database (Neon too) | local models or Groq - never embedded by Gemini |
| confidential | `phase5-rag/docs-private`, source prefix `private/` | Postgres on this machine only | local models only |

Why Groq but not Gemini, as checked on 2026-10-14: Groq does not train on API
data and keeps no prompts by default (abuse logs up to 30 days - off with Zero
Data Retention in Groq's console, which the user is turning on). Gemini's free
tier may use prompts to improve Google's products, and human reviewers may
read them.

What changed:

| Part | Before | Now |
|---|---|---|
| Search (`tools.js`) | returned any chunk in the table | leaves out `private/` chunks in the SQL itself whenever the model is not local (`MODEL_IS_LOCAL`: the model's URL is on this machine) |
| Ingest (`scripts/ingest.js`) | public + private (private only into a local database, not embedded by Gemini) | three levels from `ingestPlan()`; it prints which it skipped and why |
| Attachments (`attachments.js`) | photos, scans and long-file overviews went to Gemini wherever its key was set - also on the Mac with Ollama answering | only where `GEMINI_FILES` allows: `1`/`0`, unset = on on Vercel only. Off: photos and scans are refused (501, with the reason), the overview is the start of page 1 |
| Attach button (web) | "it was sent to the AI service" after upload | before upload too, from the server (`/api/access` → `filesGoTo`): "sent to Groq and Google Gemini" live, "read on this computer" on the Mac with Ollama |
| Startup log | - | a `data:` line: what answers may see, what ingest takes, Gemini for files on/off |
| Evals with private cases | ran them when the database was local - with `LLM_PROVIDER=groq`, private excerpts went to Groq | only when the model is local too |

Voice input is unchanged: a spoken question goes to Gemini (Whisper on Groq
as backup), as typing it goes to the answer model.

**The gap it closed:** "private documents never leave this machine" only
covered where they were *stored*. On the Mac with `LLM_PROVIDER=groq` and the
local table, the salary-band excerpts of the (made-up) private sample were
sent to Groq for judging and answering - including during earlier Groq eval
runs against the local table.

**Measured** (`npm run eval:policy` - no model calls, no quota; each setup in
its own process):

| Check | Result |
|---|---|
| Salary and escalation questions, Ollama: private document found | ✅ (4 of 40 results) |
| Same questions, `LLM_PROVIDER=groq`, same local table | ✅ 0 private results |
| Ingest plan: Mac / Neon / Gemini embeddings / both | ✅ 4/4 |
| Attachments on the Mac by default: photo and scan refused, text PDF read | ✅ |
| `GEMINI_FILES` defaults and overrides (Vercel on, `=0` off, Mac `=1` on) | ✅ 3/3 |
| What the attach button says (Mac, live, Groq on the Mac) | ✅ 3/3 |
| Total | 15/15 |
| Single-agent regression on the Mac (Ollama) | 10/10 |
| Retrieval eval on the Mac (Ollama, local table): direct, paraphrased, original, private, off-topic | 20/20, 7/10, 3/3, 4/4, 0/8 - unchanged |

### 10d.4 Connected apps: answers from other applications' live data (2026-10-15)

The reverse of `/api/ask` (10d.1): ask in the chat, and the agent reads another
application's data through its API. One generic connector for every app - an
app is **configuration in Redis, not code**, added with one command and no
deployment of this service. How an app makes itself connectable (read-only
endpoints, an access token, `openapi.json`): `apps/README.md`.

```
npm run app -- add ../apps/<app>.json      (admin API, ADMIN_KEY)
   -> its openapi.json is read: GET operations stored with the entry, token encrypted (APP_SECRETS_KEY)

question -> planner (one call, judge model): which operations, which parameters? none if not about the apps
         -> checked in code against the stored operations
         -> GET <app>/<path>, Bearer token, time limit -> JSON
         -> one numbered excerpt per call ("hall API: GET /ai/duty?date=2026-10-16"), cited like a handbook page
```

| Part | Where | Notes |
|---|---|---|
| Registry | `api/appRegistry.js` | Redis hash `apps:registry`; validation; token AES-256-GCM; read cached 30 s per instance |
| OpenAPI | `api/openapiTools.js` | OpenAPI 3; GET only, `$ref` parameters, relative `servers` URL; at most 15 operations; optional `allow` list |
| Planner + calls | `api/apps.js` | structured output (operation from an enum, args as name/value pairs), no tool loop; at most 3 calls; dates from "today" in the app's time zone |
| Single agent | `api/agent.js` | app results join the numbered excerpts; an unknown "code" is not refused when an app answered |
| Supervisor | `specialists.js` (`connected_apps`), `routing.js` | the router is told the apps at question time; no apps -> `general`; the handbook-priority rule does not take an app's question |
| Admin | `api/adminApi.js`, `api/appAdmin.js` (`npm run app`) | list, add, refresh, remove, try; off without `ADMIN_KEY` |
| Policy | `api/dataPolicy.js` (`appAllowed`) | a confidential app only with a local model |
| UI | `web/src/Message.jsx` | "Asking hall…" / "Read from hall" / "hall did not answer" chips; "Connected apps" agent label |
| Demo app | `examples/demo-app/server.js`, `apps/demo-hall.json` | made-up community hall: roster, members, dues, announcements; token-protected; no packages |

Rules in code, whatever an entry says: GET only, only stored operations, the
URL must stay under the app's base URL (path parameters are encoded),
https only (http to this machine for tests), redirects refused (the token goes
nowhere else), a time limit per call, at most ~6,000 characters of a response
in the prompt. A failed call is an excerpt too, so the answer can say "the app
did not answer in 60 s" instead of "I don't know".

Cost: with at least one app registered, every question (not small talk) makes
one more judge-model call (~700 tokens for the demo's 6 operations). With none,
nothing changes - no call.

**Measured** (`npm run eval:apps`, demo app; `ANSWERS=1` on the Mac, qwen3-coder):

| Check | Result |
|---|---|
| Registration: operations read, POST ignored, `$ref`, relative server, token encrypted, bad entries refused (wrong token, http, name, data level), `allow`, update keeps token, remove | 11/11 |
| Safety: path parameter stays in the path, http only locally, a real call, time limit (1 s on a 3 s app), refused token reported, bad plans dropped | 6/6 |
| Planner: 4 data questions call the right operation (duty with today's date, pending dues, announcements, members); rollback and "capital of France" call nothing | 6/6 |
| Answers, single agent / supervisor: right facts, cite "hall API"; the two others cite no app | 6/6 / 6/6 |
| No apps registered: no planner call | ✅ |
| An announcement question naming no app ("Is there any new announcement?"), both modes | ✅ ✅ |
| Total | 39/39 |
| End to end through the server: `npm run app -- add/list/try/remove`, no-key refused, `/api/ask` answer from the app with its source; "tomorrow" -> 2026-10-16 (Asia/Kolkata) | ✅ |
| Regressions with no app (Ollama): single, supervisor, routing | 10/10, 10/10, 24/24 |
| `eval:policy` | 15/15 |

**First real app: the masjid backend** (Express + Postgres on Render, its
own repo, branch `ai-read-api`): eight read-only `/api/ai/*` endpoints that
reuse the app's own helpers - today's food duty, the schedule, each member's
duty days in a year, members (no phones or addresses), pending dues, finance
summary with bank balances, transactions, announcements - behind
`MASJID_AI_TOKEN`, described in `aiOpenapi.js`. Tested against a throwaway
local database filled through the app's own admin routes: token refused
without/with a wrong value, no POST, bad dates rejected, no phone or address
in any response. Registered with the AI service unchanged (8 operations
read): **18/18** questions answered and cited "masjid API" (single and
supervisor), the rollback question untouched.

Found while doing it, each first reproduced:
- "What is the latest announcement?" names no app: the router sent it to
  `general` ("I don't have access...") while the single agent answered it.
  Now a part the router sends to general, coding or company_docs is planned
  too (`applyAppPriority`, routing.js) and goes to connected_apps when the
  planner finds calls; the plan is remembered 30 s, so the specialist does not
  plan again. "Is there any new announcement?" went to company_docs (the
  router was shown a handbook page about job postings) - so company_docs
  choices are planned too, and checked before the handbook rule.
- With the demo hall app registered, "When does the on-call rotation hand
  off?" made the planner fetch the hall's duty roster, and the supervisor
  regressions fell to 9/10 and 22/24. Two layers: the planner prompt now
  says the company's own processes are handbook questions unless the app is
  named (the planner then called nothing for it), and in code a company_docs
  choice is kept with the app asked as well - the synthesizer keeps what fits.
  After: single 10/10, supervisor 10/10, routing 24/24, end to end 3/3,
  history 4/4, `eval:apps` 39/39 - all with the demo app registered.

**Who may ask, and as whom** (decided with the user 2026-10-15: this service
stays generic - masjid data only through the masjid app, following the
user's role; guests only the duty schedule). `api/appAccess.js` keeps the
caller per request (AsyncLocalStorage): the web chat is `"web"`, `/api/ask` is
the app's name, code outside a request has none - and sees no apps.

| Entry field | |
|---|---|
| `callers` | required: `"web"` and/or `/api/ask` app names; masjid: `["masjid"]` |
| `user` | `none` / `optional` / `required`: `/api/ask` takes `user: { token }` - the app's own short-lived token for its logged-in user - and it is sent on as `X-User-Token`; the app decides what that user may see |
| `whoami` | the app's "who am I" operation: added in code for questions with I/me/my (found: "Do I have pending dues?" fetched only the dues list, and Fathima was told "you do not have any pending dues... Fathima Beevi owes 2,100") |

Cached plans are per caller and per user. A 403 is passed on as the app's
reason in plain words (it first read "returned a 403 error" to a visitor).

The masjid side (its repo, branch `ai-read-api`): every `/api/ai/*` call needs
the service token **and** a user token - minted per question by the masjid
server, 5 minutes, read-only, signed with a key derived from its JWT secret, so
its login checks never accept it. Admin: everything; member: schedule,
announcements, members (no one else's payment plan), own dues and payments
(`/ai/me`); guest (not logged in): `/ai/me`, today's duty, `/ai/duty-on-date`,
the schedule and yearly duty days - else 403 "log in". `/api/assistant/ask`
(masjid server, optional login) asks this service with the masjid key (never
in the browser); guests are pinned to the connected_apps agent (not a general
chatbot), need a random chat id, and get 20 questions an hour per IP
(`AI_GUEST_PER_HOUR`). The app has an Assistant page and a floating chat
button on every screen, including the login screen.

**Measured** - `eval:apps` (demo app with roles: `X-User-Token` "admin" /
"member:M-101"): 58/58, including callers (web chat, other apps and no caller
see nothing), user required/forwarded/not forwarded, a member's own dues only,
"Do I have pending dues?" for the member, both modes. End to end with the
masjid backend on a throwaway database (`/api/assistant/ask` -> this service
-> `/api/ai/*`): **23/23** - token checks (no user, user without service
token, the AI user token refused as a login, a login token refused as an AI
user token, a member's 403), admin dues and accounts, a member's own dues,
"my next duty", accounts refused, the web chat / another app / the masjid key
without a user get no masjid data, guests: today, tomorrow, a weekday, dues
refused with "log in", "capital of France" not answered, a guessable chat id
refused, the hourly limit. Browser (phone 390 px, desktop): Assistant page
and floating chat, logged in and out, no horizontal overflow. Found on the
way: "tomorrow" was planned as duty-schedule `days=1` (today only) -> a
`duty-on-date` operation in the masjid API; a reused guest chat repeated its
earlier wrong answers (the Phase 8c history effect) - each guest chat has its
own random id. Regressions (Ollama): 10/10, 10/10, 24/24, 3/3, 4/4; policy 15/15.

**Voice for apps** (2026-10-15): `POST /api/ask/transcribe` - the recording
as the raw body, the app's key, `?lang=` as a hint - the same speech-to-text
as the web chat (Gemini, Whisper as backup); not counted as a question.
`eval:ask` 11/11 with it (voice without a key 401, the English sample read).
The masjid app uses it for a mic button; its server also keeps the daily
question limits per user (members 10, guests 10 per IP, admin none) in its
own Postgres - the app knows its users, this service only sees the app.

**To turn it on** (once): `npm run app -- keys`, put `ADMIN_KEY` and
`APP_SECRETS_KEY` in `.env` and on Vercel, deploy. Then each app is
`npm run app -- add ...` with `API_URL` pointing at the server - the Mac or
https://ai-engineer-api-jet.vercel.app. The live app needs the app's API on the
internet (a Mac-only app works only with the local server).
