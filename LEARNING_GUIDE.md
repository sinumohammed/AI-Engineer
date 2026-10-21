# AI Engineer project: learning guide

A step-by-step walk through everything built in this project, from the first local model call to a
multi-agent chat app working over a real 241-page handbook, then deployed on free cloud services.
Written to be read top to bottom.

- **This guide** is the simple version: what each step is, how the flow works, what changed and why.
- **`ROADMAP.md`** is the detailed log: every experiment, number and dead end.
- **Notes files** go deep on one topic: `phase5-rag/HYBRID_SEARCH_NOTES.md`,
  `phase8-framework/FRAMEWORK_COMPARISON_NOTES.md`, `phase8b-multi-agent/MULTI_AGENT_NOTES.md`,
  `phase9-real-docs/PHASE9_NOTES.md`, `phase10-cloud/README.md`.

Contents:

1. [The big picture](#1-the-big-picture)
2. [Key words](#2-key-words)
3. [Step by step](#3-step-by-step)
4. [Iteration log: problem, change, result](#4-iteration-log-problem-change-result)
5. [The lessons that keep repeating](#5-the-lessons-that-keep-repeating)
6. [How to run everything](#6-how-to-run-everything)
7. [Where each step lives in git](#7-where-each-step-lives-in-git)

---

## 1. The big picture

The project has one idea: **start with the smallest possible thing, then add one capability at a
time, and prove each one works before moving on.**

| Step | Phase | What was added | One-line idea |
|---|---|---|---|
| 1 | Phase 1 | A model running on the laptop | Ollama serves a model on `localhost:11434` |
| 2 | Phase 2 | Calling the model from code | Send messages, get text back |
| 3 | Phase 3 | An agent | The model can ask the code to run tools |
| 4 | Phase 4 | MCP | Tools live in a separate server with a standard interface |
| 5 | Phase 5 | RAG | Answer from your own documents, not just the model's memory |
| 6 | Phase 5.5 | Combined agent | Document search becomes one of the agent's tools |
| 7 | Phase 6 | Chat UI | A browser app in front of the agent |
| 8 | Phase 6.5 - 6.11 | Memory and reliability in the UI | Sessions, Redis, token usage, summaries |
| 9 | Phase 7 | Reliability | Evals, tracing, retries, config |
| 10 | Phase 5.6 | Hybrid search | Fix search confusing similar codes |
| 11 | Phase 8a | A framework (LangChain) | Rebuild the agent with a framework and compare |
| 12 | Phase 8b | Multi-agent | A router plus specialist agents |
| 13 | Phase 8c | Multi-agent in the UI | Switch between single and multi-agent in the chat app |
| 14 | Phase 9 | Real documents | A 241-page handbook instead of 2 sample files, and everything re-measured |
| 15 | Phase 10 | On the internet | The same app on free cloud services: Vercel, Neon, Upstash, Groq |

The system on the Mac (phases 1-9, kept unchanged as the reference):

```
Browser (React, port 5173)
   │  question + session id + mode
   ▼
API server (Express, port 3001) ──── Redis (chat history per session)
   │
   ├── mode = single ──> single agent ──────────────┐
   │                                                 │
   └── mode = multi ───> supervisor (router)         │
                            ├─> company_docs ────────┤
                            ├─> coding               │
                            └─> general              │
                                                     ▼
                              document search (Postgres + pgvector)
                                                     │
                                                     ▼
                                   Ollama (the model, port 11434)
```

The same app deployed (Phase 10, a copy in `phase10-cloud/`):

```
Browser ──> web app on Vercel (static files)
   │  question + access code           Other apps' servers (Phase 10d)
   ▼                                      │  POST /api/ask + app key
API server: one Vercel function in Frankfurt <┘
   ├── embeds the question itself (the nomic model runs inside the function)
   ├── Neon, Frankfurt ──── Postgres + pgvector: the public handbook
   ├── Upstash, Frankfurt ─ Redis: chat history
   └── Groq ─────────────── gpt-oss-120b writes answers,
                            gpt-oss-20b judges search results and routes
```

---

## 2. Key words

| Word | Meaning in this project |
|---|---|
| **Model / LLM** | The program that turns text into text. Here: `qwen3-coder:30b`, run by Ollama. |
| **Ollama** | The app that runs models locally and exposes them as a web API. |
| **Messages** | The list sent to the model: `system` (instructions), `user`, `assistant`. |
| **System prompt** | The instructions at the top of the messages. Guidance, not a guarantee. |
| **Token** | A piece of a word. Models read and write tokens; limits are counted in tokens. |
| **Context window** | The most tokens a model can read in one call (`NUM_CTX`). Older text is silently dropped past it. |
| **Temperature** | Randomness. `0` gives the same answer every time, which is what tests need. |
| **Tool** | A function in your code the model can ask to be run (list files, search docs). |
| **Agent** | A loop: call the model, run any tool it asks for, give it the result, repeat. |
| **MCP** | A standard way to offer tools from a separate server. |
| **Embedding** | A list of numbers that represents the meaning of a text. Similar meaning, close numbers. |
| **Vector search** | Find the stored texts whose embeddings are closest to the question's. |
| **RAG** | Retrieval-augmented generation: find relevant text first, then let the model answer from it. |
| **Hallucination** | The model stating something false as if it were true. |
| **Eval** | An automated test for an AI system: fixed questions with checks on the answers. |
| **Trace** | A saved record of one run: what was retrieved, what was called, what was answered. |
| **Structured output** | Forcing the model's reply to match a JSON schema. |
| **Router / supervisor** | An agent whose only job is deciding which other agent answers. |
| **Specialist** | An agent with one narrow job and its own prompt. |
| **Chunk** | A small piece of a document (about 500 characters) that is embedded and searched on its own. |
| **Relevance judging (reranking)** | A model reads the search results and keeps only the ones that really answer the question. |
| **Citation** | The answer marks where each fact came from, e.g. "12 weeks [1]", and lists section [1] under it, so it can be checked. |
| **hit@k, MRR** | Search scores. hit@10: the right chunk is in the top 10. MRR: the average of 1 / its rank (1.0 = always first). |
| **Groq** | A hosted service that runs open models very fast, with a free tier. |
| **Free tier limits** | Caps per minute and per day (requests, tokens, or texts) that a free plan allows. |
| **Quantization (q8)** | Storing a model's numbers with fewer bits: smaller and faster, slightly less exact. |
| **Serverless function** | Code the host starts only when a request arrives, and stops when idle. |
| **Cold start** | The extra time for the first request after a serverless function was stopped. |
| **Fallback** | A second option used automatically when the first fails, e.g. a smaller model when the bigger one's daily limit is used up. |
| **Access code / CORS** | A shared code the API requires, and the browser rule that only the app's own website may call the API. |
| **API key (per app)** | A secret string one app sends with each request (`Authorization: Bearer <key>`), so the API knows which app is asking and can cut off one app without the others. |
| **OpenAPI** | A JSON file that lists an API's endpoints, their parameters and what each is for. Programs read it to know how to call the API; here the agent reads it to know what it may ask an app. |

---

## 3. Step by step

Each step has the same five parts: the goal, what was built, the flow, what was learned, and how to
try it.

### Step 1 - Phase 1: a model on the laptop

- **Goal:** have a model running locally, with no cloud service.
- **Built:** installed Ollama and pulled a model.
- **Flow:**
  ```
  terminal ──> Ollama ──> model ──> text
  ```
- **Learned:** Ollama starts at login and listens on `http://localhost:11434`. It holds no model in
  memory until the first request, loads it on demand (about 21 GB for the current model), and
  unloads it 5 minutes after the last request.
- **Try it:** `ollama list` (installed models), `ollama ps` (what is loaded now).

### Step 2 - Phase 2: call the model from code

- **Goal:** talk to the model from Node.js with no framework.
- **Built:** `phase2-node-ollama/chat.js` (wait for the whole answer) and `chat-stream.js` (print
  it word by word).
- **Flow:**
  ```
  your code ──POST /api/chat { model, messages }──> Ollama ──> { message }
  ```
- **Learned:** the messages array, system prompts, temperature, streaming. The model has no memory:
  it only knows what is in the messages you send.
- **Try it:** `cd phase2-node-ollama && npm run chat` and `npm run chat:stream`.

### Step 3 - Phase 3: an agent

- **Goal:** let the model do things, not just talk.
- **Built:** `phase3-node-agent/agent.js` (the loop) and `tools.js` (`list_files`, `read_file`,
  `get_current_time`).
- **Flow:**
  ```
  question ──> model ──"call list_files"──> your code runs it
                 ▲                               │
                 └────────── result ─────────────┘
              (repeat until the model answers in plain text)
  ```
- **Learned:** the model never runs anything itself. It asks, your code runs the tool and sends the
  result back. Small models sometimes write the tool request as plain text instead of in the proper
  field, so the agent has a fallback that reads it from the text.
- **Try it:** `cd phase3-node-agent && npm run agent`.

### Step 4 - Phase 4: MCP

- **Goal:** move the tools out of the agent, behind a standard interface.
- **Built:** `phase4-mcp/mcp-server.js` (offers the tools) and `client-agent.js` (the same agent
  loop, now asking the server what tools exist).
- **Flow:**
  ```
  agent (MCP client) ──"what tools do you have?"──> MCP server
  agent ──"run read_file"──> MCP server ──> result
  ```
- **Learned:** the agent no longer needs to know how a tool is implemented. Any MCP server can be
  plugged in. This is the same interface Claude Code uses for its own tools.
- **Try it:** `cd phase4-mcp && npm run agent`.

### Step 5 - Phase 5: RAG for company documents

- **Goal:** answer questions from your own documents.
- **Built:** `phase5-rag/ingest.js` (prepare the documents), `query.js` (answer a question),
  Postgres with pgvector in Docker, sample docs in `phase5-rag/docs/`.
- **Flow:** two separate jobs.
  ```
  INGEST (once per document)
  document ──> split into chunks ──> embed each chunk ──> store in Postgres

  QUERY (every question)
  question ──> embed ──> find closest chunks ──> put them in the prompt ──> model answers
  ```
- **Learned:** the model answers from the text you hand it. Quality depends on finding the right
  chunk; the model only reads what search returns.
- **Try it:** `cd phase5-rag && docker compose up -d && npm run ingest`, then
  `node query.js "What is our rollback process?"`.

### Step 6 - Phase 5.5: combined agent (RAG as a tool)

- **Goal:** one agent that can answer company questions and general questions.
- **Built:** `phase5-rag/agent.js` and `tools.js`: document search became a tool called
  `search_company_docs`.
- **Flow:**
  ```
  question ──> model decides: search the docs, or answer directly?
  ```
- **Learned:** this "model decides" design is called agentic RAG. It worked in testing, and later
  turned out to be the source of a hallucination bug (step 8, Phase 6.8).
- **Try it:** `cd phase5-rag && node --env-file=.env agent.js "What is our rollback process?"`.

### Step 7 - Phase 6: chat UI

- **Goal:** use the agent from a browser.
- **Built:** `phase6-ui/server/` (Express API) and `phase6-ui/web/` (React app).
- **Flow:**
  ```
  browser ──GET /api/chat/stream?q=...──> server ──> agent
  browser <── events: tool_call, tool_result, answer_chunk, done ──
  ```
- **Learned:** Server-Sent Events let the server push progress to the browser as it happens.
- **Try it:** `cd phase6-ui && ./start.sh`, then open http://localhost:5173.

### Step 8 - Phases 6.5 to 6.11: making the chat app real

Seven small iterations, each fixing one gap found by using the app.

| Phase | Gap found | What changed |
|---|---|---|
| 6.5 | Every question was independent; follow-ups failed | The server keeps the conversation per session id and sends it with each question. Last 10 turns only. |
| 6.6 | Memory lived inside one server process | History moved to Redis, so several server copies share it. Proved the bug with two servers first. |
| 6.7 | The context window size was never set | `num_ctx` is set explicitly, and the UI shows tokens used. |
| 6.8 | The model sometimes skipped the search and made up an answer | Search now runs on every question, in code. The model no longer chooses. |
| 6.9 | Ollama gives no warning when the context is full | The app computes its own warning at 75% and 95%. |
| 6.10 | A page refresh showed an empty chat; Redis going down crashed the server | The UI restores history on load; Redis errors are handled. |
| 6.11 | Turns older than 10 were simply forgotten | Old turns are folded into a short running summary. |

The most important one is **6.8**:

```
BEFORE (agentic RAG)             AFTER (always-retrieve RAG)
question                         question
   │                                │
model: "should I search?"        code: always search
   ├─ yes ─> search ─> answer       │
   └─ no ──> answer (may be         ▼
             made up)            model answers from what was found
```

A stricter prompt reduced the problem but did not remove it. Removing the choice did.

### Step 9 - Phase 7: reliability

- **Goal:** know when a change breaks something.
- **Built:**
  - `phase7-reliability/eval.js`: fixed questions with checks on the answers.
  - `phase5-rag/tracer.js`: one saved record per run in `phase5-rag/logs/traces.jsonl`.
  - `phase5-rag/retry.js`: retry temporary failures with a growing delay.
  - `phase5-rag/config.js` + `.env`: model, context size and thresholds set in one file.
- **Flow of an eval:**
  ```
  for each test question ──> run the agent ──> check the answer contains / avoids certain text
  ```
- **Learned:** the eval found 4 bugs that manual testing had missed, because it re-ran old questions
  after every change. One fix moved the "is this document relevant?" decision out of the prompt and
  into code, using the search distance number (`RELEVANCE_THRESHOLD = 0.5`).
- **Try it:** `cd phase7-reliability && node --env-file=../phase5-rag/.env eval.js`.

### Step 10 - Phase 5.6: hybrid search

- **Goal:** stop search confusing similar-looking codes.
- **Problem:** asking about a made-up code `XJ-9999` returned the real `XJ-2200` document, because
  the two look almost the same to vector search.
- **Built:** keyword search added next to vector search, plus a check: if the question names a code
  and that exact code is not in the document found, the agent says it has no information.
- **Learned:** vector search is good at meaning and bad at exact identifiers.
- **Try it:** ask the chat app about `XJ-2200` (answers "every 90 days") and `XJ-9999` (refuses).

### Step 11 - Phase 8a: a framework (LangChain)

- **Goal:** rebuild the same agent with a framework and measure the difference.
- **Built:** `phase8-framework/agent-a.js` and `agent-b.js`, run through the same eval.

| Version | Design | Result |
|---|---|---|
| A | Always search in code, then one model call | Same score as hand-written, less code |
| B | The model decides whether to call the search tool | 0/7 on the small model, 7/7 on the bigger one after fixes |

- **Learned:**
  - Version B's first 0/7 was mostly the small model's unreliable tool calling.
  - Version B was passing its system prompt under the wrong option name, and LangChain silently
    ignored it. A silently ignored option is worse than an error.
  - `gemma3:4b` (a 4 GB model) matches the 21 GB model on Version A and the hand-written agent,
    and cannot run Version B at all because it does not support tools.
- **Try it:** `cd phase7-reliability && AGENT_MODULE=../phase8-framework/agent-a.js node --env-file=../phase5-rag/.env eval.js`.

### Step 12 - Phase 8b: multi-agent

- **Goal:** split the work across several agents and see what that costs.
- **Built:** `phase8b-multi-agent/`: a supervisor and three specialists.
- **Flow:**
  ```
  question
     │
  1. ROUTE     router lists the parts of the message, picks a specialist for each
     │
  2. DISPATCH  company_docs | coding | general   (run together if more than one)
     │
  3. COMBINE   one specialist: return its answer as is
               several:        one more model call joins the answers
  ```
- **Files:**

| File | Job |
|---|---|
| `supervisor.js` | The hand-written flow |
| `supervisor-graph.js` | The same flow written with LangGraph |
| `routing.js` | Router prompt and rules, shared by both |
| `specialists.js` | The three specialists, shared by both |
| `llm.js` | The hand-written call to Ollama |
| `eval.js` | Routing tests, two-part tests, history tests |

- **Learned:**
  - The router picks by **structured output** (JSON forced to a schema), not tool calling, so it
    works even on models without tool support.
  - Splitting into agents created a bug the single agent did not have: "How are rollbacks done?"
    went to the coding specialist, because the router knew what each specialist is for but not what
    the documents contain. Fix: search first and show the router what was found.
  - Cost: 2 model calls per question instead of 1, and 4 for a two-part question.
  - LangGraph gave the same results with more code. It pays off for flows with loops, pauses or
    per-conversation memory, which this one does not have.
- **Try it:** `cd phase8b-multi-agent && npm run ask -- "What is our rollback process, and how do I list git tags?"`.

### Step 13 - Phase 8c: multi-agent in the chat UI

- **Goal:** use the multi-agent supervisor from the chat app and compare it with the single agent.
- **Built:**
  - A "Single agent / Multi-agent" switch in the header.
  - A row above each answer showing which specialist answered, with timings and the router's reason.
  - A dropdown to pick a specialist yourself (Auto, Company docs, Coding, General).
- **Flow:**
  ```
  browser ──?mode=multi&agent=coding──> server ──> supervisor
  browser <── events: route, agent_start, agent_done, answer_chunk ──
  ```
- **Learned:** three problems were found only by using the app, each fixed and added to the eval:

| Problem found | Cause | Fix |
|---|---|---|
| General answered a company question it should not know | It read the earlier answers in the chat history | Answers from documents are tagged when stored, and hidden from specialists that cannot read documents |
| A prompt instruction did not stop that | Text already in the conversation outweighs an instruction | The structural fix above |
| "How are rollbacks done, and how do I list git tags?" was not split | The two halves are close in topic | The router must list the parts of the message before choosing specialists |

- **Try it:** `cd phase6-ui && ./start.sh`, open http://localhost:5173, ask the same question in both modes.

### Step 14 - Phase 9: real documents at real size

- **Goal:** test search on a real corpus. Everything before used 2 made-up files (2 chunks), where
  search cannot miss.
- **Built:**
  - The public TTS Handbook (241 pages, public domain) in `phase5-rag/docs/handbook/`, and a
    git-ignored `phase5-rag/docs-private/` for confidential documents.
  - `phase9-real-docs/retrieval-eval.js`: a test of search alone, with no model call. It checks
    whether the passage that answers each question reaches the agent.
- **Flow of retrieval now:**
  ```
  question
     │
  search (vector + keyword) ──> 12 candidates
     │
  model judges: which of these answer the question?
     ├─ none ──> "the documents do not cover this"
     └─ some ──> best 4, numbered [1]..[4] ──> model answers and cites [n]
  ```
- **What changed, each step measured:**

| Step | Change | Effect |
|---|---|---|
| 9.1 | Load the handbook (2 → 2,340 chunks) | Paraphrased questions: answer in the top 4 only 3/10. The 0.5 distance threshold called 5/8 off-topic questions relevant. |
| 9.2 | Clean the text: strip front matter, template tags, link addresses, HTML | Top result correct for 14/20 direct questions, was 7/20 |
| 9.3 | Cut chunks at headings, label each "Page > Section", 500 characters, nomic task prefixes | Direct 17/20 top result; private docs 4/4, was 2/4 |
| 9.4 | Let the model judge relevance instead of a distance threshold | Off-topic wrongly treated as relevant 0/8, was 7/8. Costs about 1.7s per question. |
| 9.6 | Citations: answers say which document section each fact came from | 37/37 document answers cite a source |

- **Learned:**
  - At 2 chunks, search could not fail, so the earlier tests could not see search problems. A test
    of search on its own found them.
  - A threshold tuned on a tiny corpus breaks when the corpus grows: off-topic questions moved from
    0.67 to as close as 0.30.
  - Cleaning and structure (what goes into a chunk) mattered more than the chunk size.
  - The prompt-versus-code lesson came back twice: a stronger router instruction did not stop it
    sending "Who is eligible for FMLA?" to the general specialist, and a rule in code did.
- **Try it:** `cd phase9-real-docs && npm run eval`, then `npm run eval:citations`. In the chat app,
  ask "How much paid parental leave do I get?" and look at the Sources under the answer.


### Step 15 - Phase 10: on the internet, on free services

- **Goal:** run the chat app on the internet instead of only on the Mac, on free tiers, without
  disturbing the working local app.
- **Built:**
  - `phase10-cloud/`: a self-contained copy of the chat app (`api/`, `web/`, `scripts/`, `eval/`).
    Phases 1-9 are frozen as the local reference; only the copy changes.
  - Settings for every outside service, so the same code runs on the Mac or in the cloud.
  - Deployed: web app https://ai-engineer-web-seven.vercel.app, API on Vercel in Frankfurt,
    documents in Neon, chat history in Upstash, models on Groq. An access code protects it.
- **Flow of one question in the cloud:**
  ```
  browser ──(access code)──> API function (Frankfurt)
     │
  0. "hi"/"thanks" -> answered directly, no search      (small talk, decided in code)
     "translate that"/"make it shorter" -> reworks the last answer, no search
  1. a follow-up ("who is eligible for it?") gets "it" replaced:  "...for FMLA?"
     a question in Malayalam, Hindi, Spanish... is translated to English for the search only
  2. embed the question inside the function, search Neon ──> 10 candidates
  3. gpt-oss-20b judges which candidates answer it ──> best 4, numbered
  4. gpt-oss-120b answers and cites [n]
     (20b and 120b stand in for each other when one's daily limit is used up, with a note)
  5. the turn is saved in Upstash
  ```
- **What changed, each step measured:**

| Step | Change | Effect |
|---|---|---|
| 10a.1 | Copy the app into one folder | Every eval exactly as in Phase 9 |
| 10a.2 | One model client for Ollama and Groq | Groq first 3/7; 7/7 after fixing invisible characters and accepting new wordings |
| 10a.3 | Connection settings instead of `localhost` | Testing wrong values found 3 silent failures, all fixed |
| 10a.4 | Embeddings without Ollama | Gemini's free tier was too small; the nomic model inside Node gave the same search results |
| 10a.5 | Neon, Upstash, Groq together | Follow-ups fixed, model split, judging 30% cheaper, fallback when a daily limit runs out |
| 10b.6 | Deploy on Vercel with an access code | Through the public URL: 12/12, both modes |
| 10b.7 | Fixes found on the live app and the Groq evals | Two-way fallback, small talk, rework requests, router 24/24 on gpt-oss |
| 10b.8 | Search in English for questions in other languages | Malayalam, Hindi, Spanish: 5/18 to 17/18, answers still in the user's language |
| 10b.9 | New UI with Ant Design X, installable as an app (PWA) | Phone, tablet and desktop layouts; home-screen icon; opens offline; Chrome: 0 installability errors |
| 10b.10 | Voice input: record in the browser, Gemini writes the text (Groq Whisper as backup) | Works in every browser and the installed app; Malayalam 3/3 in Malayalam script with the language picked, ~1.5 s |
| 10b.11 | Reply in the language of the question | A Malayalam question after English turns was answered in English; now in Malayalam. English prompts unchanged |
| 10b.12 | Date and time on every message | Small time under each message, full date on tap, "Today" / "Yesterday" dividers; stored with the history |
| 10b.13 | Attach a PDF or a photo (step 1: short files) | Text PDFs read on the server, photos and scans by Gemini; the file is cited like a handbook source |
| 10d.1 | Other apps can ask: `POST /api/ask`, JSON in and out, one key per app | Live: 9/9 (keys, bad requests, a question, a conversation); ~1.4 s a question after a ~6 s cold start |
| 10d.2 | Long attachments: chunks searched per question, like the handbook | 59-page tax guide: the fact reaches the model 8/8 (before: 4/8); answers 8/8 single and multi-agent; live upload 95 s |
| 10d.3 | Which documents may go to which services: public, internal, confidential | Confidential excerpts reach a local model only (before: Groq too); files go to Gemini on the live app only; 15/15 checks, no model quota |
| 10d.4 | Connected apps: answers from other applications' live data, added as configuration | Demo app: 36/36 (planner, answers in both modes, safety); adding an app needs no deployment |
| 10d.5 | First real app (masjid): who may ask, and as which user | Live: the masjid app's chat answers guests the duty schedule from real data; the web chat sees no masjid data; end to end 23/23 |
| 10d.6 | The masjid assistant in daily use: limits in Settings, a phone-first chat, hands-free voice, rupees, Malayalam names, a repeatable test | Live: "Sinu TK" finds സിനു ടി കെ, "this month" gives October; `eval:masjid` 40/40 |
| 10e | Command Center: usage and cost per app and per user, the agents at work live, ask by voice or by clapping twice | Live: web and masjid questions counted with their cost (9 questions, $0.0086 at paid prices); `eval:masjid` 41/41 |
| 10d.7 | App keys stored in Redis as hashes: a new app is one command, no redeploy | Live: both apps on stored keys, `APP_API_KEYS` deleted from Vercel; `eval:ask` 11/11 |
| 10d.8 | Masjid assistant: last year's dues for everyone, a new look, ready questions in Malayalam | Live: the admin's "previous year pending" answered (was a 400); Malayalam questions 6/6 on Groq; `eval:masjid` 53 checks |
| 10d.9 | MCP: apps can connect as MCP servers, and masjid became one | Live: the masjid assistant answers over MCP (`today_duty (MCP tool)`), refusals unchanged; `eval:mcp` 47/47, `eval:masjid` over MCP 62/63 |
| 10d.10 | Claude Code reads the masjid data: personal MCP tokens made in masjid Settings | Live: Claude Code connected to masjid and answered from its data; token checks 12/12 |
| 10d.11 | Tables and charts in answers, for apps whose screen can show them | Every figure in a table or chart equal to the API's, on qwen and Groq 3/3; other prompts unchanged |
| 10d.12 | The masjid app redone: one emerald-and-gold look, About the masjid, photos uploaded in the app, charts that answer questions | Screenshots on phone and computer, light and dark; colours checked for colour blindness |
| 10d.13 | The masjid assistant on Telegram: members link by sharing their phone number, voice notes answered | Live: linked as the admin, the bot answered; 21 bot checks against a fake Telegram, Groq 67/67 |
| 10d.14 | Charts over time: income and expense by month and by day, two series in one chart, the admin's 30-day and this-year cards; Copy, Image, Print under each answer; the time under each message | Groq: every figure in the charts from the data, both new cards right; print checked on a phone and a computer |
| 10d.15 | The masjid assistant answers masjid questions only, for everyone | Live: a coding question gets the masjid-only reply, with no model call; "show that as a bar chart" still works |
| 10d.16 | A second real app, KMCC savings: the same assistant and Telegram bot, members see only their own money, added with no change to this service | Live on MCP; a member's savings, profit and withdrawals year by year match the Profile statement; Groq 45/45 |
| 10d.17 | Each app's on/off switch and its own daily and monthly limits, in the Command Center (admin key only) | `eval:app-limits` 14/14: paused refused at once, limits refuse the next question, refused questions not counted |

- **Challenges, in plain terms:**

| Challenge | What happened | Fix |
|---|---|---|
| Different API format | Ollama and Groq expect and return different shapes | One shared client that speaks both |
| Invisible characters | gpt-oss writes a no-break space in "90 days" and cites as 【1】: fine on screen, but the citation parser found nothing and correct answers failed tests | The client turns them into plain characters |
| Different wording | "10 a.m.", "I'm not aware of": correct, but new words, and different on every run | Tests accept more phrasings, never wrong facts |
| Stricter judging | qwen kept four loose matches, so a vague follow-up worked by luck; gpt-oss judged strictly and it failed | Replace "it" with what it refers to before searching |
| The model rewrites too much | Asked to rewrite the follow-up, qwen stuffed in facts and moved the right section from rank 1 to 9 | The model only names "it"; code puts the name in |
| An old router bug | For a follow-up, the router re-added the earlier question (Phase 9 did too) | Repeated questions are dropped in code |
| Free limits | Groq: 8,000 tokens a minute and 200,000 a day per model. Gemini: 1,000 embedded texts a day | 120b answers, 20b judges; embeddings run inside the server |
| Hidden thinking costs tokens | gpt-oss's reasoning counted as ~288 tokens per judgement | Low reasoning effort for judging: ~60 tokens, same scores |
| Silent failures | A wrong database password looked like "no relevant documents"; a database restart crashed the server | Errors logged; a connection pool that recovers |
| Deploying | The first Vercel deploy built nothing (framework "Other"): every page was a 404 | The framework is set in `vercel.json` |
| A public app | Anyone with the URL could spend the free quota | An access code on every request |
| One-way fallback | With 20b's daily limit used up, every question failed at the judging step: the fallback only covered 120b | Each model stands in for the other |
| "hi" cost 2,000 tokens | A greeting went through search, judging and the router | Small talk is recognised in code and answered directly |
| "Tell that in Malayalam" | Searched as a new question: "I don't have information about that" | Requests to translate, shorten or simplify rework the last answer, no search |
| Broken JSON | gpt-oss-20b sometimes broke the router's JSON format and Groq refused the reply | Retried, then the existing safe fallback |
| Answering in the wrong language | After English turns, a Malayalam question got an English answer | A rule to reply in the user's language - added only when the message is not English, because it changed how qwen worded English answers |
| Citing an attachment | Told "don't number facts from the file", qwen numbered them anyway - a receipt total was cited as a handbook travel page; a PDF heading "3. Hotels" became citation [3] | The file is one more numbered excerpt, and its number is named in the prompt |
| Two sources, one question | With a travel policy attached, "how many days before departure must flights be booked?" went to the handbook only; a router instruction to ask both was ignored | In code: a one-part question that shares words with the file also goes to the file; the reply says which source says what |
| Malayalam voice | Whisper wrote Malayalam speech in Tamil, Gujarati or Gurmukhi script, even when told the language | Gemini 3.5 Flash Lite with the user's language as a hint; Whisper only as a backup |
| Whisper hears words in silence | A silent recording came back as "Thank you." with full confidence (`no_speech_prob` 0), so the server cannot tell | The browser measures the mic level; a recording that never gets loud is not sent |
| Answers wider than a phone | One long code line made a whole answer 696 px wide on a 390 px screen | `min-width: 0` on the chat bubbles; code scrolls inside its box |
| Other languages | The handbook and the embedding model are English: a Malayalam question found its passage only when it named "FMLA" | Translated to English for the search and the judge only; the model answers the original, in the user's language |
| Other apps asking | The API only spoke the web app's stream and its single access code | `POST /api/ask` with one key per app; each app's conversations kept apart; 100 questions a day per app, because every app spends the same free Groq quota as the web app |
| An empty secret? | Vercel's edit box showed the new key as empty after saving | Normal: a Sensitive value is never shown again. The real problem was the name: saved as `eval` instead of `APP_API_KEYS`; `npx vercel env ls` shows the names |
| A long file | Only the first ~12,000 characters were read: about 3 pages of a 59-page tax guide | Cut into page-labelled chunks at upload, embedded inside the function; each question gets the 4 best chunks and a short overview |
| Which questions get a long file | "Two words in common with the file" matched almost any question for a 59-page file | Two of the file's topic words (on 5%+ of its chunks) in one chunk: 9/9 |
| The router's rewording | The supervisor split and reworded questions, and the file was searched with the reworded part: the page with the answer dropped out (5/8) | Search the file with the user's own message: 8/8 |
| A slow helper service | Gemini, asked for the overview, was overloaded all day; one upload waited 273 s, close to Vercel's 300 s limit | A time limit per try and less text to read; the upload goes on without the overview |
| Two-part questions on gpt-oss | Both gpt-oss models split "How are rollbacks done, and how do I list git tags?" correctly, then sent the rollback part to `general` | Each part is searched on its own; a part the documents answer goes to company_docs |

- **Learned:**
  - "Change the URL" was never the whole job: each new provider brought its own format, characters,
    wording and limits, and each was found by an eval, not by reading the docs.
  - A stricter model exposed weaknesses a lenient one had hidden. qwen passed the follow-up by luck.
  - Free tiers decide the design: the per-day token limit made us split the work across two models
    and cut the judging cost.
  - The prompt-versus-code lesson again: "use the short name" was ignored; a smaller job for the
    model (name the thing) plus code (substitute it) worked on both models.
  - Make silent failures loud: a wrong password, mixed embedding models, a dropped connection all
    looked like normal behaviour until checks were added.
  - Real use finds what evals miss: "tell that in Malayalam" and "hi" were never in a test; both came
    from using the live app, and both are tests now.
  - A fallback must cover every model call, not only the answer: the judging step had no fallback,
    so one used-up limit stopped every question.
- **Other apps (10d.1):** an app's backend sends one request and gets one JSON answer:
  ```
  other app's server ──POST /api/ask──> API function
     Authorization: Bearer <that app's key>       1. which app? (key -> name), else 401
     { question, conversationId? }                2. today's count for that app, over 100 -> 429
                                                  3. history of "app:<name>:<conversationId>"
                                                  4. the same agent as the chat (single or multi)
     <── { answer, sources, notices, usage }     5. the turn saved under that app's conversation
  ```
  The key stays on the app's server, never in browser code. `phase10-cloud/examples/ask-client.js`
  is the code to copy: one `fetch`, no packages. Not yet: attachments or streaming through it.
- **Long attachments (10d.2):** the same RAG idea as the handbook (Step 5), but for one file and
  inside the function, with no database:
  ```
  upload:    PDF pages -> chunks of ~1,200 characters, each with its page number
             -> one vector per chunk (the same nomic model as the handbook) -> kept with the chat in Redis
             + a short overview of the file (Gemini; the start of page 1 if Gemini is down)
  question:  question vector vs every chunk + exact words and figures ("$1 million", "6.2%")
             -> best 4 chunks, in page order -> one excerpt: overview + those pages -> the model cites the file
  ```
  A file that fits ~12,000 characters still goes in whole. Try it with
  `phase10-cloud/eval/samples/irs-pub15-employers-tax-guide.pdf` (59 pages): "When do I have to start
  withholding Additional Medicare Tax?" is answered from page 30.
- **Which documents may go where (10d.3):** before real documents are added, a rule, enforced in
  code (`phase10-cloud/api/dataPolicy.js`) from the settings, so a wrong `.env` cannot break it:
  ```
  level          folder                         stored in          read by
  public         phase5-rag/docs (in git)       anywhere (Neon)    any model
  internal       phase10-cloud/docs-internal    anywhere (Neon)    local models or Groq, never Gemini
  confidential   phase5-rag/docs-private        this Mac only      local models only

  question -> search ──(model is local?)── yes: every level
                                       └── no:  confidential chunks left out in the SQL itself
  attached file -> Gemini? only where GEMINI_FILES allows (default: the live app only)
  ```
  Why Groq but not Gemini: Groq does not train on API data and keeps no prompts by default (Zero
  Data Retention turns off even its abuse logs); Gemini's free tier may let human reviewers read
  prompts. The attach button now says where a file goes before you upload it. Check it with
  `cd phase10-cloud/eval && npm run eval:policy` (no model calls).
- **Connected apps (10d.4):** the reverse of `/api/ask` - ask in the chat, and the agent reads another
  application's data through its API. One generic connector; each app is a configuration entry in
  Redis, not code, so adding one needs no deployment:
  ```
  add an app:  npm run app -- add apps/masjid.json  ->  its openapi.json is read: the GET calls it offers
  question:    planner (one model call): which calls, with which values? none if not about the apps
               -> code checks them, calls the app's API with its token -> JSON
               -> one numbered excerpt per call, cited "masjid API" like a handbook page
  ```
  The app's side: a few read-only endpoints for the AI, an access token for them, and an
  `openapi.json` describing them (`phase10-cloud/apps/README.md`). Try it with the demo app:
  `cd phase10-cloud/eval && ANSWERS=1 npm run eval:apps`.
- **Who may ask, and as whom (10d.5):** the service stays generic. Each app names its callers, and
  the app itself decides what each of its users may see:
  ```
  AI web chat ("web")           -> no masjid data (masjid's callers: ["masjid"])
  masjid app, its own key       -> masjid server mints a 5-minute read-only token for the user
     guest                      -> duty schedule only; anything else: "log in"
     member                     -> schedule, announcements, own dues and payments
     admin                      -> everything
  ```
  The user's login token never leaves the masjid server. Every key, where it lives and which way it
  goes: "Keys at a glance" in `phase10-cloud/README.md`.
- **The masjid assistant in daily use (10d.6):** what members asked for, each fixed where it belongs:
  ```
  4 questions a day      -> masjid app: counted in its Postgres; the admin changes it in Settings
  phone: box off screen  -> masjid app: the chat is as tall as the visible screen (visualViewport);
         and zoomed in      every text field 16px (iPhone zooms into smaller ones)
  voice: tap twice       -> masjid app: a 1.5 s pause ends the recording; Auto-send asks at once
  "$" amounts            -> masjid API says "amounts in INR (₹)"
  "Sinu TK" not found    -> masjid API: Malayalam names turned into English letters and compared
                            loosely (initials, ids, a letter or two off) - all 35 real names are Malayalam
  "this month" = January -> AI service: every app result says today's date
  ```
  `cd phase10-cloud/eval && npm run eval:masjid` runs the masjid app end to end with made-up data
  (41 checks) - after any change on either side.
- **Command Center (10e):** with more apps coming, the service has to say who uses it, how much,
  and what that costs - per app, like a bill. Every request is metered without changing the code
  that calls the models:
  ```
  a request (web chat, an app's /api/ask, voice, a file)
    runs inside metered()            one "meter" per request (AsyncLocalStorage)
      every model call  -> model, tokens   (recorded in chat(), the one place all calls pass)
      every app call    -> app, operation, ok, time
      every specialist  -> its name
    -> one row in Postgres: which app (its key = its billing identity), which user inside it,
       agents, models, tokens, cost = tokens x list price, time, ok/error
       never the question or the answer
  ```
  The Command Center (`#/command` in the web app, opened with a read-only dashboard key) shows it:
  totals, questions per day per app, **billing by app**, top users, agents, models, app calls and
  recent requests. Its console asks the agents by typing, by voice, or hands-free - **clap twice**,
  a chime, speak - and shows the question's path live (You -> Router -> specialists -> Combiner ->
  Answer) with a log of the hand-offs; the answer can be read aloud. On free tiers the real bill
  is $0; the dashboard shows what the same use would cost on paid tiers. The masjid app sends who
  asks as a code ("member:MR001", "admin", an anonymous code for visitors), never a name.
  Later in 10e: answers read aloud in Malayalam and Arabic (Gemini's voice; English keeps the
  device's), **conversation mode** (after two claps it listens again by itself after each answer,
  talk or tap to interrupt, ~8 s of silence ends it), the agents answer questions about usage
  ("how many questions today?") through the service's own usage registered as a connected app, and
  the Errors tile lists what failed. Live: "how many questions today, did anything fail?" answered from the numbers (5 questions, $0.072), the web chat sees none.
- **App keys in Redis (10d.7):** an app's ask-key works like a house key. Each app keeps its own
  key (masjid's `AI_ASK_KEY`, the eval's `ASK_API_KEY`); only the service's list of accepted keys
  moved - from the env var `APP_API_KEYS` (retype every key on Vercel, redeploy) to Redis:
  ```
  npm run app -- askkey new masjid
    -> key ak_... made, shown ONCE (give it to the app)
    -> Redis ask:keys:  sha256(key) -> { name: "masjid" }      the key itself is never stored

  masjid --Bearer ak_...--> /api/ask -> sha256(given) in ask:keys? -> "masjid"  else 401
  ```
  **Hashed, not encrypted:** the service only has to recognise the key, never send it, so a
  one-way fingerprint is enough - whoever reads Redis gets no usable key. An app's token (the
  other direction, service -> app) must be sent, so that one is encrypted. `revoke` stops a key on
  the next request; an app can hold two keys while one replaces the other.
- **The masjid assistant, polished (10d.8):** the admin's "previous year pending" got a 400 -
  `dues_by_year` handled one member, and the admin is not one. Now, with no member named, the
  admin gets everyone who still owes for that year (`everyone`, refused to members). The chat got
  its own mark (a masjid dome as a bot's head, crescent on top), a green launcher, a header that
  says whom it answers as, answer cards, and **ready questions in Malayalam** for each role: admin
  (last month's accounts, this month's spending, members with dues, last year's dues, bank
  balances), member (my dues, my next duty, last year, my payments, announcements), guest (duty
  today, tomorrow, this week, Friday). Each is a check in `eval:masjid`; `ONLY=chips` runs just
  those on Groq. Found: the local model made the right calls but misread the data when answering
  in Malayalam (4/6); Groq, which the live app uses, 6/6. And an app change takes two steps in
  order: deploy the app, *then* `npm run app -- refresh masjid` - the first refresh ran before the
  deploy finished and read the old description.
- **MCP, the second way to connect an app (10d.9):** Phase 4 put tools behind MCP on one machine
  (a server started as a child process). Now it runs over HTTP between two deployed services. An
  app's entry gives either its OpenAPI file or its MCP server; everything after that is the same:
  ```
  OpenAPI app:  GET openapi.json  -> GET operations  --+
                                                       +-> stored as "operations" -> planner -> call -> excerpt
  MCP app:      initialize, tools/list -> read-only  --+
                tools (readOnlyHint)
  a call:       OpenAPI: GET /ai/today-duty        MCP: tools/call "today_duty"
  ```
  The masjid backend now has both doors to the same rooms: `/api/ai/mcp` lists 11 tools made
  from its OpenAPI description, and a tool call runs the same handler as the GET endpoint - same
  admin/member/guest rules, same refusal reasons. MCP has no GET, so the connector uses only
  tools the server marks read-only. The client is hand-written over `fetch` (like the rest of the
  connector); the demo server and masjid's server use the official SDK, so the two sides check
  each other. Found: the label under the excerpt matters - with a bare `pending_dues` the local
  model told a paid-up member "nobody owes" every time; `pending_dues (MCP tool)` fixed it, on
  identical data.
- **Claude Code reads the masjid data (10d.10):** with masjid an MCP server, Claude Code could
  list its tools but every call was refused - a call needs the 5-minute user token that only the
  masjid server makes, per question, for the AI service. A person's tool needs a person's key:
  ```
  masjid Settings -> "Claude access (MCP)" -> Create      (admin)
    -> mcp_... shown once + the ready `claude mcp add` command
    -> masjid keeps only sha256(token) -> your user
  Claude Code --Bearer mcp_...--> /api/ai/mcp -> your user, your role read now -> the 11 tools
  ```
  The token opens `/api/ai/mcp` only, is not a login, and Revoke stops it at once. Two Claude
  Code details found on the way: "already exists in local config" means remove the entry and add
  again; and `-s local` (the default) ties the server to the folder the command ran in - `-s user`
  makes it work everywhere. These questions go straight from Claude Code to masjid (no Groq, no
  AI service); what Claude reads goes to Anthropic, so tokens are admin-only for now.
- **Tables and charts in answers (10d.11):** an app now says what its screen can show, and only
  then does the answer prompt ask for it:
  ```
  masjid server --POST /api/ask {..., display: {tables: true, charts: true}}--> AI service
     + a rule in the answer prompt: 4+ records -> a Markdown table, figures copied exactly;
       "as a chart" -> a ```chart block {type: bar|pie|line, data: [{label, value}]}
  masjid chat: draws the table and the chart (recharts); a broken chart block is dropped
  ```
  Other apps, the web chat and the evals get exactly the prompts they had. "Show that as a bar
  chart" reworks the previous answer without a new search. The eval checks every figure in the
  table and the chart against what the API returned - a model copying numbers can copy one wrong.
- **The masjid app redone (10d.12):** one palette (emerald and gold, light and dark) on every
  screen, a guest page about the masjid and its people instead of a login box, member photos
  uploaded in the app instead of copied into the code, and dashboard charts that each answer one
  question in a sentence. Red against green failed a colour-blindness check (a script measured
  it - ΔE 3.7); emerald and gold pass. Built while the user watched two local previews: the new
  frontend against the live API, and a local backend on a throwaway database.
- **The masjid assistant on Telegram (10d.13):** a second door to the same assistant. The bot
  lives in the masjid app, not in the AI service, because the logins, roles and limits are there:
  ```
  Telegram --webhook (secret header)--> masjid server /api/telegram/webhook
     answers 200 at once, the rest runs in waitUntil; an update seen before is skipped
     which login? channel_links: Telegram account -> masjid user   (none: a guest)
     voice note -> download -> speech-to-text (Malayalam by default) -> shown back
     askAssistant(): the same function as the app's chat - same roles, same daily limits
  <-- sendMessage (the Markdown answer turned into Telegram's HTML)
  ```
  Linking is done by the person: "Share my phone number" (Telegram sends the account's own
  number - checked that the contact is the sender - matched to the member record), or a one-time
  link from the app (10 minutes, works once). Private chats only, so dues never show in a group.
  Tested against a fake Telegram, which found an old bug: a member asking about another member's
  dues was told "he owes nothing" (the list was already cut to the member's own) - now refused.
- **Charts over time (10d.14):** "last year's income as a line chart" drew nothing - the masjid API
  had one total per period, and a chart one series. Now:
  ```
  finance_by_month / finance_by_day (masjid API, admin)  ->  a figure per month / per day
  chart block: "series": ["Income", "Expense"], data: [{label, Income, Expense}]  ->  two lines
  ```
  Under every answer: Copy (tables paste as columns), Image (a picture with the chart, shared on a
  phone) and Print (Save as PDF). Each message shows its time. Two things went wrong on the way
  and were measured: an extra example in the prompt made the local model draw charts nobody asked
  for, and adding the monthly endpoint made "what was spent this month, on what" pick it and lose
  the categories - until its description said it has none.
- **Masjid answers only (10d.15):** the user's decision - the masjid app and bot answer from masjid
  data only, for everyone. Logged-in users had the full agent (handbook, coding, general); now
  every question goes to the connected-apps agent, and an off-topic one gets a fixed reply in code,
  with no model call. That broke "show that as a bar chart" (a pinned agent skipped the rework
  step) - the eval found it, and rework is now allowed for that agent.
- **A second app, KMCC savings (10d.16):** the user's savings-and-loan app got the same assistant
  - and this service needed no code for it, only a key and a registry entry (the promise of 10d.4):
  ```
  KMCC app (TypeScript)                        this AI service
  /api/ai/* + /api/ai/mcp  (12 read-only)  <-- planner picks tools, calls them as the member
  /api/assistant/ask, Telegram bot          --> POST /api/ask with KMCC's own key
  ```
  Members see only their own money; the admin everything. The real data taught three things after
  it went live: the model passed "my" as a member's name (now: a member's unmatched search means
  themselves); "in/out" read wrongly for profit credited to a member (now credit/debit, as on the
  Profile statement); and profit and the 2017 opening balance were filed under Saving, told apart
  only by their descriptions ("Profit 2024") - so the assistant reads the description and gives
  each year's contribution, profit and withdrawals.
- **App switch and limits (10d.17):** the Command Center can pause any app and give it its own
  daily and monthly question limits - only with the admin key; the dashboard key just views. Before,
  one number for all apps, changed only by a deploy.
- **Try it:** open https://ai-engineer-web-seven.vercel.app (the access code is `HOSTED_ACCESS_CODE`
  in `phase10-cloud/.env`). Locally: `cd phase10-cloud && ./start.sh`, then
  `cd eval && npm run eval:public` to test the deployed app. Another app's view:
  `cd phase10-cloud/examples && npm run ask -- "What is our rollback process?"`.

---

## 4. Iteration log: problem, change, result

Every row is one loop of "find a problem, change one thing, measure again".

| # | Phase | Problem | Change | Result |
|---|---|---|---|---|
| 1 | 3 | Small model writes tool calls as plain text | Fallback that reads the tool call from the text | Agent keeps working |
| 2 | 6 | Model re-reads source files to "verify" search results and fails | Told it not to in the prompt; the tools were removed outright in 6.8 | Answers stop derailing |
| 3 | 6.5 | No memory between questions | Per-session history, last 10 turns | Follow-ups work |
| 4 | 6.6 | Memory lost across server copies | History in Redis | Two servers share one conversation |
| 5 | 6.7 | Context size unset, silent truncation possible | Set `num_ctx`, show token usage | Usage visible in the UI |
| 6 | 6.8 | Model skips search and hallucinates | Always search in code | Hallucination gone |
| 7 | 6.9 | No warning near the context limit | Own warning at 75% / 95% | Banner in the UI |
| 8 | 6.10 | Redis outage crashed the server | Error handling, graceful fallback | Server survives, recovers |
| 9 | 6.11 | Old turns forgotten | Running summary | Gist of old turns kept |
| 10 | 7 | General question answered with nonsense | Relevance decided in code by distance | Passes |
| 11 | 7 | Model echoed "I don't know" from the prompt | Stopped quoting that phrase in the prompt | Passes |
| 12 | 7 | Model looped on the only tool left | Removed the tool | 5/5, faster |
| 13 | 5.6 | Made-up code matched the real one | Exact-identifier check | Refuses the wrong code |
| 14 | 8a | Version B scored 0/7 | Found the small model's tool calling was the cause | Documented, not patched |
| 15 | 8a | Version B's system prompt silently ignored | Correct option name | 6/7 |
| 16 | eval | Correct answers failing on wording | Accept several phrasings, normalise apostrophes | All agents 7/7 |
| 17 | 8b | Company question sent to coding | Show the router the search result | 17/17 |
| 18 | 8c | Combined answer said "based on the specialists" | Told the joiner to answer as one assistant | Clean answers |
| 19 | 8c | Wrong specialist repeats company facts from history | Tag and hide document answers | 4/4 refuse |
| 20 | 8c | Close-topic two-part questions not split | Router lists parts first | 20/24 to 24/24 |
| 21 | 8c | That fix split a one-part question | Label the user's message and the excerpt | 24/24 |
| 22 | 9.1 | Tests could not see search problems at 2 chunks | Real corpus + a retrieval-only eval | Baseline: paraphrased 3/10 |
| 23 | 9.1 | A test assumed "the docs say nothing about backups" | Accept "not specified", forbid an invented schedule | 7/7 |
| 24 | 9.2 | Markup inside chunks | Clean text before chunking | Top result 7/20 → 14/20 |
| 25 | 9.3 | Chunks cut mid-topic, no context | Heading-based chunks with a "Page > Section" label, 500 characters | 17/20, private 4/4 |
| 26 | 9.3 | Off-topic questions under the 0.5 threshold | Model judges relevance instead (9.4) | 0/8 false positives |
| 27 | 9.6 | Answers did not say where facts came from | Numbered excerpts, cited sources in the UI | 37/37 cite |
| 28 | 9.6 | Router sent document questions to the general specialist | Code rule: document-answerable goes to company_docs | 37/37 from docs |
| 29 | 10.1 | Cloud changes would disturb the working local app | Self-contained copy, phases 1-9 frozen | Every eval identical |
| 30 | 10.2 | Groq speaks a different API format | One client for Ollama and OpenAI-style APIs | Ollama unchanged, Groq works |
| 31 | 10.2 | gpt-oss writes no-break spaces and 【1】 citations | Turn them into plain characters in the client | Citations parsed again |
| 32 | 10.2 | Correct answers in new wording | Four more phrasings accepted | Groq 3/7 to 7/7 |
| 33 | 10.3 | Wrong database password was silent | Log every failed search | Visible in the server log |
| 34 | 10.3 | One failed connection broke search; a database restart crashed the server | Connection pool with an error listener | Survives and recovers |
| 35 | 10.4 | Gemini's free tier: 1,000 embedded texts a day | The nomic model inside Node (q8) | Same search results, 2 minutes to embed |
| 36 | 10.4 | Mixing embedding models fails silently | Each table labelled with its model; mismatches refused | Refused with a clear message |
| 37 | 10.5 | "Who is eligible for it?" failed on gpt-oss | Replace "it" before searching | 8/8 |
| 38 | 10.5 | The rewrite stuffed in facts (rank 1 to 9) | The model names "it", code substitutes | Clean rewrites on both models |
| 39 | 10.5 | Router re-added the earlier question (also in Phase 9) | Drop repeated questions in code | Supervisor 8/8 |
| 40 | 10.5 | Groq allows 200,000 tokens a day per model | 120b answers, 20b judges and routes | About 80 questions a day instead of 55 |
| 41 | 10.5 | Judging spent tokens on hidden reasoning | Low effort for judging, 10 candidates | 30% fewer tokens, same or better scores |
| 42 | 10.5 | A used-up daily limit showed as "connection error" | Fallback model, clear "try again in N minutes" | Tested on a mock and on Groq |
| 43 | 10.6 | The first deploy built nothing | Framework set in `vercel.json` | Live |
| 44 | 10.6 | A public app spends the free quota | Access code, allowed origin | No code: refused |
| 45 | 10.7 | gpt-oss-20b broke the router's JSON format; Groq returned an error | Retry, then the safe fallback | No crash |
| 46 | 10.7 | 20b's daily limit used up: every question failed | Two-way fallback (20b and 120b) | Answers keep coming, with a note |
| 47 | 10.7 | "hi" spent 1,000-2,000 tokens | Small talk answered without search | 0 extra tokens |
| 48 | 10.7 | "Tell that in Malayalam" searched as a new question | Rework the last answer from the conversation | Malayalam and Hindi work live |
| 49 | 10.7 | Two-part questions: one part sent to `general` on gpt-oss | Document check per part, in code | Routing 22/24 (20b), 21/24 (120b) to 24/24 |
| 50 | 10.8 | Questions in other languages missed the English handbook | Translate for the search only; non-English detected in code | 5/18 to 17/18 (16/18 on qwen), off-topic 0/3 |
| 51 | 10.9 | The UI was one fixed card: cramped on a phone, no app icon | Ant Design X chat components, responsive layout, PWA | Installable, opens offline, checked at 390, 820 and 1440 px |
| 52 | 10.10 | Typing on a phone is slow; questions in Malayalam or Hindi even more so | Mic button: MediaRecorder + Groq Whisper; the text lands in the box to check | English and Hindi recordings transcribed; silence caught before upload |
| 53 | 10.10 | "Malayalam voice not taking": Whisper wrote it in other scripts | Gemini 3.5 Flash Lite + a "Voice language" setting as a hint | Malayalam 0/3 to 3/3 in the right script; still finds the handbook passage |
| 54 | 10.11 | Malayalam question after English turns answered in English | Reply-language rule, only for non-English messages | Fixed on Groq; local English evals back to 10/10 and 3/3 after limiting the rule |
| 55 | 10.12 | No way to see when a message was sent | Time stored with each turn; shown small, full date on tap | Survives reloads; old turns show none |
| 56 | 10.13 | Attachment facts cited as handbook pages | The file gets its own excerpt number, named in the prompt | Receipt, text PDF and scanned PDF all cited as the file |
| 57 | 10.13 | The file stayed attached to every later question (found by the user) | Like a chat app: it goes with its message; later only with related follow-ups, decided in code | Paris and "And in London?" read the file; "git tags" did not |
| 58 | 10.13 | Receipt, then a scanned PDF + "explain it": the receipt was explained (found by the user) | With a new file, skip the "it" rewrite, route to the file, and put the file's name in place of a bare "it" | "Explain it" and "What is this?" explain the new file, both modes |
| 59 | 10.13 | Still the receipt: earlier answers about it were in the history and qwen repeated them; a question sent mid-upload went with the old file | Earlier answers about a different file hidden from the model (as in 8c); no sending while a file is read | Receipt twice, then the scan: the scan is explained, both modes |
| 60 | 10d.1 | Other apps could not use the agent: only the web app's stream and one shared access code | `POST /api/ask`: JSON in and out, one key per app, conversations per app | Mac 9/9, live 9/9; another app's key with the same conversation id saw nothing |
| 61 | 10d.1 | A looping app could use up the free Groq quota the web app needs | A daily limit per app, counted in Redis | Limit 1: the second question got 429 with a clear message |
| 62 | 10d.1 | Piped questions into the example client: the follow-up was lost | Read lines in order instead of asking one at a time | Both questions answered, the follow-up with the first one's context |
| 63 | 10d.2 | A long PDF was read only to page 3 | Chunks, vectors and an overview at upload; the best 4 chunks per question | Fact reaches the model 4/8 to 8/8; ~1,260 tokens instead of up to 3,000 |
| 64 | 10d.2 | Every later question got the long file | Two topic words of the file in one chunk, instead of two words anywhere | 9/9 (6 unrelated without, 3 tax questions with) |
| 65 | 10d.2 | Supervisor searched the file with the router's reworded part | Search with the user's own message | 5/8 to 8/8 |
| 66 | 10d.2 | Gemini overloaded: an upload waited 273 s | 20 s per try, 2 tries, only the start of each page; go on without it | Mac upload ~20 s; live 95 s (embedding on Vercel's CPU) |
| 67 | 10d.2 | A short PDF's heading "3. Hotels" cited as [3] when the file was excerpt [1]: no source shown (row 56's fix had stopped holding) | In code: a number that matches no excerpt becomes the file's | 0/3 to 3/3, both modes; handbook citations unchanged |
| 68 | 10d.3 | "Private documents never leave this Mac" only covered where they were stored: with `LLM_PROVIDER=groq` and the local table, salary-band excerpts went to Groq | Search leaves out `private/` chunks in SQL whenever the model is not local | Same questions: 4 private results with Ollama, 0 with Groq; retrieval eval unchanged (20/20, 7/10, 3/3, 4/4, 0/8) |
| 69 | 10d.3 | On the Mac, every photo, scan and long-file overview went to Gemini's free tier, even with Ollama answering | `GEMINI_FILES`: on by default on Vercel only; off = photos and scans refused with the reason, overview from page 1 | Photo and scan refused, text PDF still read; the attach button names the services before upload |
| 70 | 10d.4 | Each new app would need its own specialist code and a deployment | One generic connector; apps as entries in Redis, read from their `openapi.json` | Demo app added, used and removed with one command each, no deployment |
| 71 | 10d.4 | Letting the model call app APIs as tools risks loops and invented calls | A planner picks from a fixed list (structured output); code checks and makes the calls: GET only, listed paths, time limit | Planner 6/6 (4 data questions call the right operation, 2 others call nothing); bad plans dropped in code |
| 72 | 10d.5 | "What is the latest announcement?" went to the general agent (supervisor) | A part sent to general, coding or company_docs is also planned; app calls found -> connected_apps | 17/18 to 18/18 |
| 73 | 10d.5 | With a duty-roster app connected, "on-call rotation" fetched the roster | Planner told the company's own processes are handbook questions; a handbook choice keeps the handbook and asks the app too | Regressions back to 10/10, 24/24 with the app connected |
| 74 | 10d.5 | Masjid data would be open to every web chat user | `callers` per app; the user passed through; the app filters by role | Web chat and other apps: no masjid data; a member sees only their own dues |
| 75 | 10d.5 | "Do I have pending dues?" told Fathima she had none ("...Fathima owes 2,100") | The app's "who am I" call added in code for I/me/my | Answered for the asking user |
| 76 | 10d.5 | A guest's "tomorrow" was asked as "the next 1 day" (today) | A duty-on-date operation in the masjid API | Live: tomorrow's member named |
| 77 | 10d.5 | Live: a member asked (in Malayalam) for the pending-payments list and was told "no members have pending dues" - their own list was empty, the admin's page showed many | Filtered data says it is filtered ("only your own; the full list is for the admin"); the chat shows "Asking as" | The member is told they owe nothing and only the admin sees others; the admin gets the full list |
| 78 | 10d.5 | Members wanted to speak questions, see recent ones and a fair share of the free quota | Voice through the AI service's speech-to-text (`/api/ask/transcribe`); recent questions; 10 questions a day per user, counted in the app's own database | Live: Malayalam voice read, the count goes 10 -> 9, voice not counted |
| 79 | 10d.6 | The limit had to change without a deploy | 4 a day by default; the admin edits members / visitors / admin limits in Settings (stored in the app's database) | A change applies from the next question |
| 80 | 10d.6 | On a phone the chat box fell below the screen, and typing zoomed the page past the edges | The chat sized to the visible screen (visualViewport, shrinks with the keyboard); all fields 16px on phones | 9/9 on an emulated iPhone, also with a 380 px "keyboard" |
| 81 | 10d.6 | Voice needed a second tap; answers said "$"; "[1]" puzzled members | A pause ends the recording, Auto-send asks at once; the API says amounts are INR; source numbers hidden, "From: Masjid records" shown | Stopped at 4.9 s (1 s quiet + 2.4 s speech + 1.5 s pause) and answered; amounts in ₹ |
| 82 | 10d.6 | The masjid checks were one-off scripts: two bugs reached the user first | `eval:masjid`: the real masjid backend on a throwaway database, every role and limit check | 34 -> 40 checks; found that fetch refuses port 5061 ("bad port") |
| 83 | 10d.6 | "Dues of Sinu TK" found nobody - every real name is in Malayalam, the test names were English | Masjid code turns Malayalam names into English letters and compares loosely (initials, ids, near spellings) | All typed forms find the right member among the 35 real names; live: "Sinu TK" -> MR#001 |
| 84 | 10d.6 | "This month" was answered with January | Each app result says today's date in the app's time zone | Live: October 26, matching the app's own schedule |
| 85 | 10e | The service could not say who uses it or what it costs per app: a daily count in Redis for 48 hours, tokens sent back and forgotten, logs kept ~30 minutes | Every request metered (one row in Postgres, never the text); cost = tokens x list price per model | Local, Ollama and Groq: the right app, agents and models; cost checked by hand. Live: 9 questions from the web chat and the masjid app, $0.0086 |
| 86 | 10e | A dashboard in a browser would hold the admin key, which can change the connected apps | A read-only `DASHBOARD_KEY`: usage and nothing else | Dashboard key: usage 200, every other admin call 401 |
| 87 | 10e | Clap to wake: two claps did not wake it in the test | The test's fake microphone played only on the first of two streams (React opens it twice in development); and browsers start audio paused until a tap - the page now resumes it or asks for one tap | Synthetic audio 4/4: two claps wake it; one clap, speech-like sound and slow claps do not |
| 88 | 10e | The Users column was empty: apps did not say who asks | `user.ref` on `/api/ask`; the masjid app sends the member code, "admin" or an anonymous visitor code; a Top users panel | `eval:masjid` 41/41: member codes and visitor codes, no names. Live: a masjid visitor shows as `guest:47c1ef06a6` |
| 89 | 10e | On a phone the Command Center's mic heard nothing and never stopped; no way to stop it; clap to wake kept the mic on (found by the user) | Recording starts inside the tap (started a moment later, the phone kept audio paused); 8 s with no speech ends it; Stop buttons; clap to wake off on every visit, lets go of the mic while busy, "Mic on · Turn off" shown | Emulated iPhone: stops 1.4 s after speech, gives up at 8 s, short pauses not cut; "Turn off" leaves 0 live mic tracks |
| 90 | 10e | Answers were read aloud on a computer but not on a phone (found by the user) | Phones allow speech only from a tap: a silent phrase inside the tap unlocks it; long answers read sentence by sentence | Emulated: unlock inside the tap, the answer in 3 pieces of up to 220 characters |
| 91 | 10e | Malayalam answers were read as "dot dot", Arabic not at all: devices have no voice for them (found by the user) | English keeps the device voice; other scripts go to Gemini's voice (`/api/speak`, detects the language), never for answers citing internal documents | Live: Malayalam and Arabic audio in ~5-6 s; the Malayalam audio back through speech to text gives the same sentence; internal source refused with the reason |
| 92 | 10e | "My pending of last year" got no answer in the masjid app (found by the user): the assistant could only ask what is owed now | Masjid API: `dues_by_year`, the same calculation as the profile page's year selector; a member gets only their own year | `eval:masjid` 44/44: 2025 -> ₹1,200, 12 months missed; another member's year refused. A reworded description ("current calendar year") told a paid-up member "no members have pending dues" - reverted |
| 93 | 10e | The console could not answer "how many questions today?" or "what did masjid cost?" (asked by the user) | The service's own usage registered as an ordinary connected app, `usage` (read-only views, dashboard key); its only caller is `command`, which the Command Center becomes by sending its key | Local, Groq: routed to the usage app, answered from the numbers; the web chat without the key: no usage data |
| 94 | 10e | The Errors count did not say what failed (asked by the user) | The Errors tile and each app's count open a list: failed requests with their error, and answered questions where an app call failed; a 403 (the app refusing by role) shown as expected | Local: 1 real failure and 10 expected refusals, told apart; the agents can list them too |
| 95 | 10e | Every turn needed a clap or a tap, and a long answer could not be interrupted (asked by the user) | Conversation mode: listens again by itself after each answer; talking over the answer or tapping the orb interrupts; ends after ~8 s of silence, "stop" / "bye" / "മതി", or End | Simulated on a phone-sized page: two turns, then ended at 8 s; a 20 s answer stopped 1.1 s after the user spoke; "Stop" ends |
| 97 | 10e | Live, found by the new "what failed" list: 3 read-aloud failures - Gemini's voice allows 10 requests a day on the free tier, and each 2-3 sentence piece was one request | A device voice for the language first when there is one (no limit); Gemini at most 2 requests per answer instead of ~6; a used-up limit says so and when it resets | Phone-sized page: a long Malayalam answer 2 requests (was ~6), Arabic with a device voice 0; live, the real 429: "used up - it resets in about 21 h 24 min" |
| 98 | 10e | No way to see how much of the free tiers was left (asked by the user) | "Free tier today" per model: Groq's own requests-left figure (sent on every response), our token count against 200K a day, "used up until" from a provider's refusal; Gemini reports none - its TTS limit came from its own error | Local, real figures: Groq 999 / 998 of 1,000 requests left, ~194K of 200K tokens; Gemini voice "used up, back 4:00 AM". Then "≈ N more questions today" (whichever limit first, 7-day averages): tokens, not requests, are the real limit, and gpt-oss-20b (~2.7 calls a question) runs out before 120b |
| 96 | 10e | Request times showed the clock only, and were hidden on phones | Today: the time; "Yesterday 6:32 PM"; older: the date; tap or hover for the full date | Phone: visible, a tap shows "Saturday, October 17, 2026 at 6:09 AM" |
| 99 | 10d.7 | Each new app's key meant retyping every key in `APP_API_KEYS` on Vercel (it never shows a saved value) and a redeploy | Keys in Redis as SHA-256 hashes: `npm run app -- askkey new / import / list / revoke`; the env var still read during the move | Local: env and stored keys 200, wrong 401, a revoked key refused at once; live: eval key imported, masjid given a new one (its old key could not be read back), `APP_API_KEYS` deleted, `eval:ask` 11/11 |
| 100 | 10d.8 | The admin's "previous year pending" got no answer (found by the user): `dues_by_year` returned 400 - it handled one member | Masjid API: with no member named, the admin gets every member still owing that year, with the total (`everyone`; members refused) | `eval:masjid` 47/47; live: the same call succeeded. The first refresh ran before the masjid deploy finished - refresh after the deploy |
| 101 | 10d.8 | The assistant looked generic and its suggestions were English only (asked by the user) | A masjid-bot mark and launcher, a polished chat (header, answer cards, bullets), ready questions in Malayalam per role, as cards and chips | Screenshots: admin, member, guest; phone and computer; light and dark - nothing wider than the screen |
| 102 | 10d.8 | Do the Malayalam questions reach the right data? | 6 checks in `eval:masjid`; `ONLY=chips` runs only those, to use little Groq quota | Groq 6/6. Local qwen 4/6: the right calls, the data misread in Malayalam - Malayalam answers are checked on Groq |
| 103 | 10d.9 | Apps could connect only through an OpenAPI file; many products offer MCP servers instead | A second connector type: `"mcp": "<url>"`, the server's read-only tools stored as operations, `tools/call` per question (hand-written client); a demo MCP server with the official SDK | `eval:mcp` 27/27, with answers 47/47 (single and supervisor); `eval:apps` 31/31 unchanged. The test's slow server on port 4045 got "fetch failed": fetch refuses that port, like 5060 |
| 104 | 10d.9 | Masjid's data only reachable through its OpenAPI endpoints | `/api/ai/mcp` on the masjid backend: tools made from its OpenAPI description, each running the endpoint's own handler; listing needs the service token, a call also the user's | 10 new MCP checks in `eval:masjid`; `CONNECTOR=mcp` runs every check over MCP: 62/63 (the miss: a Malayalam answer on local qwen) |
| 105 | 10d.9 | Over MCP a paid-up member heard "no members have pending dues" (0/5); over OpenAPI 5/5 - on the same data, byte for byte | The excerpt label `pending_dues` became `pending_dues (MCP tool)` (OpenAPI's is `GET /ai/pending-dues`) | 5/5. Live (Groq): masjid switched to MCP; a guest's duty question answered from `today_duty (MCP tool)`, a dues question refused with "log in" |
| 106 | 10d.10 | Claude Code could list masjid's tools but not call them: a call needs the 5-minute user token only the masjid server makes | Personal MCP tokens: made by the admin in Settings, shown once with the `claude mcp add` command, stored as a hash, role read at each use, `/api/ai/mcp` only | 12/12 in `eval:masjid`, incl. the official MCP SDK client with the token alone; live: Claude Code connected and answered |
| 107 | 10d.10 | "MCP server masjid already exists in local config"; then no masjid tools in another folder (found by the user) | Remove the entry and add again; `-s local` belongs to the folder it ran in, `-s user` to every folder | Working from any folder |
| 108 | 10d.11 | Pending dues came as a plain list; tables and graphs on request (asked by the user) | `display` on `/api/ask`; a table rule (and a chart block when asked) in the answer prompt, only for apps that ask; the masjid chat draws them | Tables and charts 3/3 on qwen and Groq, every figure from the API; other evals unchanged |
| 109 | 10d.11 | Charts empty in a screenshot, a table's amount column off a phone screen | Charts without grow-in animation (the chat resizes often); text columns wrap, amounts never do | All columns on a 390 px screen; charts drawn at once |
| 110 | 10d.12 | Dashboard charts: one dot per day (~280), no values; red/green for in/out | Month-by-month bars with the answer above, categories with amount and share; emerald/gold - red/green failed the colour-blindness check (ΔE 3.7) | Every check passes, light and dark; opening balances (a third of "income") left out and named |
| 111 | 10d.13 | The assistant only inside the app; members use their messaging apps every day (roadmap #5) | A Telegram bot in the masjid app: webhook, link by the account's own phone number or a one-time app link, voice notes, the app chat's own ask function | 21 bot checks against a fake Telegram; Groq 67/67; live: linked as the admin and answered |
| 112 | 10d.13 | A member asking for Abdul Rasheed's dues heard "he has no pending dues" - he owed ₹3000. The check passed: it only looked for the amount | `pending-dues?search=` another member, asked by a member: refused (403), as `dues_by_year` already was; the check also fails on "no pending" and wants "admin" | Refused, pointing to the admin, on Groq and qwen. The app's own chat had the same bug |
| 113 | 10d.14 | "Last year's income as a line chart" drew nothing (found by the user): one total per period, one series per chart | `finance_by_month` in the masjid API; chart blocks with `series` | Groq: a line chart of the year, income vs expense in one chart, every figure from the API |
| 114 | 10d.14 | gpt-oss wrote `{label, Income, Expense}` without `"series"` | The chat takes the series from the first item's keys | 54/54 on Groq |
| 115 | 10d.14 | A second full example in the chart rule: qwen added a chart nobody asked for and dropped its citation | The multi-series form as one sentence, with figures that are not the test's | The answer is plain again |
| 116 | 10d.14 | With the new endpoints listed, "spent this month, on what" lost its categories | Their descriptions say "totals only, no categories (in finance_summary)" | Categories back, on Groq |
| 117 | 10d.14 | Print: blank on a computer, then blank everywhere | A copy of the answer under `<body>`; the receipt's print CSS hides `body *` for every print, so the copy is made visible | Only the answer, on white, phone and computer |
| 118 | 10d.15 | Members got handbook and coding answers from the masjid assistant | Everyone pinned to `connected_apps` | Off-topic: a fixed reply in 0.2 s, no model; live checked |
| 119 | 10d.15 | That broke "show that as a bar chart": a pinned agent skipped the rework step | Rework allowed when the pinned agent is `connected_apps` | Bar chart back; the web chat unchanged |
| 120 | 10d.16 | A second app, KMCC: another language (TypeScript, Prisma), no guests, members' money | The masjid pattern: read-only `/api/ai/*` and MCP, the assistant, Telegram; dues worked out without writing; this service unchanged | `eval:kmcc` 49/49 (no model and Telegram); ready questions right on Groq; live |
| 121 | 10d.16 | Telegram linking by phone would never match a Saudi number: `05...` on the record, `+9665...` from Telegram | Match the last 9 digits (two matches are refused) | Linked with `+966 50 ...` in the eval |
| 122 | 10d.16 | Over MCP on Groq, a member's "my loan balance" got "no loan found": the model passed "my" as the member search | A member's search that names nobody means the member | Right on Groq; 2 checks |
| 123 | 10d.16 | Live: a member's profit and withdrawals answered wrongly - flows were "in/out" (money into KMCC), only one withdrawal category counted | Credit / debit as on the Profile statement; withdrawals of both kinds; profit credited as its own figure | Savings, profit, withdrawn right on Groq |
| 124 | 10d.16 | Live: KMCC0049's profit was 0 - profit and the 2017 opening balance are filed under Saving, told apart only by the description | A Saving credit is read by its description; opening, contributed, profit, withdrawn and balance, overall and per year; largest entries with descriptions | 45/45 on Groq; live |
| 125 | 10d.16 | A fixed tool description did not reach the assistant | This service keeps a copy of each app's tools: read it again after the app's deploy is Ready (it was read too early twice) | Confirmed live |
| 126 | 10d.17 | One daily limit for every app, changed only by a deploy; no way to stop one app | Per-app pause, daily and monthly limits in Redis, set in the Command Center with the admin key only | `eval:app-limits` 14/14 |

Where things stand (Phase 10 code):

| Test | On the Mac (Ollama, qwen3-coder) | In the cloud (Groq, documents in Neon) |
|---|---|---|
| Single agent, 8 cases (a follow-up added in Phase 10) | 8/8 | 8/8 |
| LangChain Version A and B, 7 cases (Phase 8a) | 7/7 each | - |
| Supervisor routing, 24 cases | 24/24 (hand-written and LangGraph) | 24/24 (router on gpt-oss-20b or 120b) |
| Supervisor two-part answers / history leak cases | 3/3, 4/4 | 3/3, 4/4 |
| Supervisor on the 8 single-agent cases | 8/8 | 8/8 |
| Retrieval: answer reaches the agent | 34/37 (37 cases, 4 private) | 31/33 (public only, gpt-oss-20b judging) |
| Retrieval, off-topic questions wrongly treated as relevant | 0/8 | 0/8 |
| Retrieval in Malayalam, Hindi, Spanish (18 cases, 3 off-topic) | 16/18, 0/3 | 17/18, 0/3 |
| Citations: document answers that cite a source | 37/37 (single and multi-agent) | 32/33 single, 32/33 multi-agent (public only) |
| Through the public URL, both modes | - | 12/12 |
| `POST /api/ask` for other apps (keys, bad requests, a question, a conversation) | 9/9 | 9/9 |
| `/api/ask` keys stored in Redis (10d.7): stored and env keys, wrong, revoked, reserved names | 11/11 `eval:ask` with a stored key; key checks by hand | 11/11 live, Redis keys only |
| Long attachment, 59 pages: fact reaches the model / answers single, multi / which questions get it | 8/8 / 8/8, 8/8 / 9/9 | 4/4 live questions right |
| Data policy: what search, ingest and attachments may send where (no model calls) | 15/15 | - (the live API names Groq and Google Gemini for files) |
| Connected apps, demo app: registration, safety, planner, answers single and multi | 36/36 | - (no app on the internet registered yet) |
| Connected apps over MCP (10d.9), demo MCP server: registration (read-only tools only), typed arguments, users, refusals, sessions, time limit; planner and answers | 27/27; with answers 47/47 | masjid over MCP: 2/2 guest questions (answered, refused) |
| Personal MCP tokens (10d.10): member refused, shown once, tools as the admin, official SDK client, other endpoints refused, revoke | 12/12 (`eval:masjid` 1c) | live: Claude Code connected, questions answered |
| Tables and charts in answers (10d.11): a table with every member and amount, "as a bar chart" with the same figures, one fact stays a sentence | 3/3 (`eval:masjid ONLY=tables`) | 3/3 on Groq |
| Masjid app end to end: tokens, roles (admin, member, guest), isolation | 23/23 (test database) | 6/6 live (guest questions on real data, web chat and other apps see nothing) |
| `eval:masjid`: the masjid backend + this API on a throwaway database - roles, limits, names in English letters, isolation, who-asks codes, a past year's dues (one member, and everyone for the admin), the Malayalam ready questions | 51/53 (the 2 misses: Malayalam answers on the local model); with the 10 MCP checks (10d.9) 61/63, and over MCP (`CONNECTOR=mcp`) 62/63 | Malayalam ready questions 6/6 (`ONLY=chips`); live: "Sinu TK this month" and "MR1 in November" match the app's schedule |
| Telegram bot (10d.13), against a fake Telegram: wrong secret, linking by phone (own number only, unknown number) and by app link (once only), a retried update not answered twice, groups ignored, roles over Telegram, voice notes | 21/21 (`eval:masjid ONLY=telegram`, voice with `VOICE=1`) | 21/21 on Groq; live: linked as the admin, answered |
| Charts over time (10d.14): month and day endpoints (opening balance left out, member refused, range limits), a line chart of the year, income vs expense in one chart, the admin's two chart cards | endpoint checks 5/5 | 54/54 (`ONLY=tables`), both cards right (`ONLY=chips`) |
| Masjid answers only (10d.15): a member's handbook question and the admin's coding question not answered; "show that as a bar chart" after a table | 3/3 | live: off-topic question gets the masjid-only reply |
| `eval:kmcc` (10d.16): KMCC backend + this API on a throwaway database - tokens, roles (members refused others' data and KMCC's totals), dues worked out, names (Malayalam, initials, codes), MCP, limits, Telegram against a fake Telegram, a member's statement and year by year, isolation | 49/49 no model + Telegram; with answers 71/72 (qwen dropped one citation on a right answer); over MCP 49/49 | ready questions, member statement, year by year: 45/45 on Groq |
| `eval:app-limits` (10d.17): dashboard key refused, pause refuses questions and voice, daily and monthly limits, refused not counted | 14/14 | live: the controls open with the admin key |
| Usage metering and Command Center: caller, agents, models, cost recorded; dashboard key reads usage only; clap to wake (synthetic audio) | right on Ollama and on Groq; key 200 / 401; claps 5/5; phone voice 3/3; read-aloud unlock and languages; conversation 3/3 (simulated) | live: web and masjid questions recorded with app calls and cost; masjid users as codes |

---

## 5. The lessons that keep repeating

Several of these were first learned on 2 sample documents and had to be qualified once Phase 9
loaded a real handbook. The wording below is the current version; the table after the list shows
what changed.

1. **A prompt is advice when it asks the model to follow a rule.** A stricter prompt failed where a
   change in code worked: always-search (6.8), hiding tagged answers (8c), and in Phase 9 a router
   instruction that did not stop "Who is eligible for FMLA?" going to the general specialist.
   **Exception found in 9.4:** a focused question with a structured answer ("which of these
   excerpts answer the question?") did respond to better wording, from 1 to 0 false positives out
   of 8. Asking a model to obey a policy against its own preference failed; asking it to judge one
   specific thing worked. Measure either way. **Phase 10:** "use the short name" was ignored by
   qwen; giving it a smaller job (just name what "it" means) and doing the rest in code worked.
2. **Let code decide when it has a reliable signal, and re-check the signal when the data changes.**
   Relevance by vector distance (Phase 7) was a reliable code rule at 2 chunks and failed at 4,288.
   It was replaced by the model's judgement (9.4), which in turn feeds a code rule
   (`applyDocPriority`, 9.6). In Phase 10 the same rule was extended to each part of a two-part
   question: both gpt-oss models split the question correctly but guessed the wrong specialist for
   one part, and a per-part document check in code fixed it on every model.
3. **Remove the wrong option instead of forbidding it.** Unused tools were deleted, not discouraged.
4. **Prove the bug before fixing it.** Each fix started by reproducing the failure, so the fix could
   be measured.
5. **Re-run old tests after every change.** Most bugs were regressions: a fix for one question broke
   another.
6. **Tests can be wrong too.** Correct answers failed on wording; a test set with only easy two-part
   questions hid a routing bug; a test assumed the documents say nothing about backups, which
   stopped being true.
7. **Using the app finds what tests miss.** All three Phase 8c problems came from clicking around,
   then became permanent tests.
8. **More agents means more places to fail.** Multi-agent added routing mistakes and memory leaks
   between agents, and doubled the model calls. Use it when one prompt can no longer do the job.
9. **Test the parts, not only the final answer.** A retrieval eval with no model call found
   problems that answer tests could not see, and showed which step to fix.
10. **A result measured on toy data is a guess about real data.** The 0.5 threshold, fixed
    800-character chunks and "the keyword search rarely helps" were all right for 2 chunks and
    wrong for 4,288.
11. **Bigger is not always needed, so far.** For "read this text and answer", a 4 GB model matched a
    21 GB one, and size mattered when the model had to choose and call tools. On the handbook
    (Phase 10), gpt-oss-20b judged search results as well as gpt-oss-120b.
12. **Different models fail differently.** A lenient model can pass by luck: qwen kept a vague
    follow-up working by keeping four loose matches; strict gpt-oss exposed the weakness, and an old
    router bug with it. Test with more than one model before trusting a design.
13. **Free tiers have limits you only find by hitting them.** Per minute, per day, per request or
    per text, and different for every service: Gemini counts each embedded text (1,000 a day), Groq
    counts tokens per day per model. The limits shaped the design.
14. **Make silent failures loud.** A wrong database password looked like "no documents found", a
    framework ignored a misspelt option, and two embedding models mixed in one table would give
    plausible wrong results. Each now fails with a clear message.
15. **Where data is stored and where it is sent are two different rules.** Private documents were
    never stored on a hosted database, yet their excerpts were sent to a hosted model every time
    one answered (10d.3). Follow the data through every call, not only to where it rests.
16. **Make the variable part data, not code.** Each app differs only in its address, its endpoints
    and its token, so those became a configuration entry; the code that calls apps safely is
    written once (10d.4). A new app is a command, not a deployment.
17. **Who may see data is the data owner's decision, enforced where the data is.** The AI service
    only says who is asking; the masjid app decides what an admin, a member or a guest sees
    (10d.5). A prompt saying "don't show other members' dues" would be advice; a 403 is a rule.
    **And filtered data must say it is filtered:** an empty list "for this member" read as "nobody
    owes anything" until the response said whose list it was.
18. **Test data must look like the real data.** The test members had English names; every real
    member's name is in Malayalam, so "Sinu TK" failing was invisible until a user asked (10d.6).
    Now the masjid eval includes a Malayalam-named member searched in English letters.
19. **Measure in the one place everything passes through.** Every model call goes through `chat()`,
    so usage is recorded there once, for every agent, app and fallback - not in each of the ~10
    callers (10e). The same request-scoped trick already carried notices; now it carries the meter.
    **And give each key only what it needs:** the dashboard reads usage with its own key, so the
    key that can change apps never sits in a browser.
20. **A description is part of the program.** The planner chooses by the API's descriptions and
    the model words its answer from them: adding "in the current calendar year" to the pending-dues
    description made a fully paid member hear "no members have pending dues" again (10e). Change one
    the way you change code - and re-run the evals.
21. **Hash what you only check; encrypt what you must send.** An app's ask-key only has to be
    recognised, so the service keeps a one-way hash; an app's token has to be sent to the app, so
    it is encrypted and can be read back (10d.7). Pick by what the secret is for.
22. **Test in the user's language, on the model the user gets.** The local model planned the
    Malayalam questions right and still misread the answers; Groq, which the live app uses, got
    all six (10d.8). A test that passes on one model says little about another.
23. **Everything the model reads is prompt - even a label.** The same JSON with the label
    `pending_dues` instead of `GET /ai/pending-dues` turned a right answer into a wrong one, every
    time (10d.9). When two paths give different answers, compare what the model actually read,
    byte for byte, before blaming the model.
24. **A service's key and a person's key are different keys.** The AI service holds one long-lived
    service token and gets a fresh 5-minute token per user per question; a person's tool (Claude
    Code) has neither, so it got its own: made by that person, revocable, with their role read at
    every use and opening only one door (10d.10). Decide who holds a key before deciding its shape.
25. **What can be measured, measure - even colour.** Green against red looked fine and failed a
    colour-blindness check by a wide margin (10d.12); a script found it in a second. The same goes
    for a model's numbers in a table: check each one against the data, do not eyeball it (10d.11).
26. **A check must fail on the wrong answer, not only on the leak.** "Does not show Abdul's
    amount" passed while the answer said Abdul owed nothing - safe, and false (10d.13). Write down
    what a right answer says, and check for that.
27. **An example in a prompt gets copied.** With a second example chart in the prompt, the local
    model added a chart nobody asked for - under the example's own title, "Pending dues by member"
    (10d.14). Keep examples few, and never use the test's own numbers in them.
28. **A new tool changes how the old ones are chosen.** Adding a monthly-totals endpoint made "what
    was spent this month, on what" pick it and lose its categories (10d.14). After adding a tool,
    re-run the questions the other tools answered.
29. **Real data hides meaning in free text.** KMCC's profit was filed under Saving and told apart
    only by its description, "Profit 2024"; the category totals said "profit 0" and were right about
    the categories, wrong about the money (10d.16). Read real rows before trusting the schema.
30. **When figures disagree, first check they are about the same thing.** The pasted Profile rows
    that "disproved" the assistant were another member's (10d.16). Name and code first, then numbers.
31. **A copy goes stale.** This service keeps a copy of each app's tool descriptions; a fix in the
    app does nothing until the copy is read again - after the app's deploy is Ready (10d.16).

### What changed when the data got real (Phase 9)

| Earlier decision | Measured on | What Phase 9 found | Now |
|---|---|---|---|
| Relevance = vector distance under 0.5 (Phase 7) | 2 chunks: real questions 0.36-0.44, off-topic 0.67 | Off-topic questions as close as 0.30; 7 of 8 treated as relevant | The model judges relevance (9.4) |
| Fixed 800-character chunks of raw text (Phase 5) | 2 tiny files | Markup inside chunks, cuts mid-topic | Cleaned text, cut at headings, 500 characters, "Page > Section" labels (9.2, 9.3) |
| Embeddings with no task prefix (Phase 5) | Never tested | The embedding model expects `search_document:` / `search_query:` | Prefixes on (9.3) |
| Keyword half of hybrid search "rarely contributes" (5.6) | 2 chunks | Rescued answers vector search missed | Confirmed as needed |
| "Distance means company_docs" routing rule rejected (8b) | Noisy distances | Works with the model's judgement as the signal | `applyDocPriority` in code (9.6) |
| Always search, in code (6.8) | 2 chunks | Still right | Unchanged; the search now feeds the relevance step |

---

## 6. How to run everything

One-time setup per machine: install Node, Ollama and Docker Desktop, pull the models
(`ollama pull qwen3-coder:30b` and `ollama pull nomic-embed-text`), copy `phase5-rag/.env.example` to
`phase5-rag/.env`, and run `npm install` in each folder that has a `package.json`.

| What | Command |
|---|---|
| Start the database | `cd phase5-rag && docker compose up -d` |
| Create the tables (new database only) | `cd phase5-rag && docker exec -i phase5-rag-db-1 psql -U rag -d rag < schema.sql` |
| Load documents | `cd phase5-rag && npm run ingest` |
| Start the chat app | `cd phase6-ui && ./start.sh`, then open http://localhost:5173 |
| Single-agent eval | `cd phase7-reliability && node --env-file=../phase5-rag/.env eval.js` |
| Multi-agent eval | `cd phase8b-multi-agent && npm run eval` |
| Multi-agent eval, LangGraph | `cd phase8b-multi-agent && npm run eval:graph` |
| Ask the supervisor from the terminal | `cd phase8b-multi-agent && npm run ask -- "your question"` |
| See what is loaded in memory | `ollama ps` |

To try another model, change `CHAT_MODEL` in `phase5-rag/.env` and restart the chat app.

Phase 10 (`phase10-cloud/`, its own `.env`; see `phase10-cloud/README.md`):

| What | Command |
|---|---|
| The copy on the Mac (local services) | `cd phase10-cloud && ./start.sh`, then open http://localhost:5174 |
| All evals | `cd phase10-cloud/eval && npm run eval:retrieval` (also `eval`, `eval:supervisor`, `eval:citations`, ...) |
| Evals on Groq | prefix with `LLM_PROVIDER=groq CHAT_MODEL=openai/gpt-oss-120b JUDGE_MODEL=openai/gpt-oss-20b` |
| Judging cost and quality | `cd phase10-cloud/eval && npm run eval:judge` |
| Questions in other languages | `cd phase10-cloud/eval && npm run eval:multilingual` |
| Test the deployed app | `cd phase10-cloud/eval && npm run eval:public` |
| Test a long attachment | `cd phase10-cloud/eval && npm run eval:long-file` (`ANSWERS=1` asks the agent too, `AGENT=multi` the supervisor) |
| Test `/api/ask` for other apps | `cd phase10-cloud/eval && npm run eval:ask` (needs `ASK_API_KEY` in `.env`) |
| Check which documents may go where | `cd phase10-cloud/eval && npm run eval:policy` (no model calls) |
| Connected apps | `cd phase10-cloud/api && npm run app -- list` (also `add <file>`, `try "question"`, `remove <name>`); test: `cd phase10-cloud/eval && npm run eval:apps`; an MCP app: `"mcp": "<url>"` instead of `"openapi"` in its file (`apps/demo-hall-mcp.json`), test `npm run eval:mcp`; masjid over MCP: `CONNECTOR=mcp npm run eval:masjid` |
| Claude Code with the masjid tools | masjid app → Settings → Claude access (MCP) → Create, then `claude mcp add -s user --transport http masjid https://masjid-management-omega.vercel.app/api/ai/mcp --header "Authorization: Bearer mcp_..."`; check with `claude mcp list` and `/mcp`. Remove: `claude mcp remove masjid -s user`, and Revoke in Settings (the one that closes access; do it if the Mac is lost - the token is in plain text in `~/.claude.json` and never expires) |
| The masjid assistant on Telegram | masjid app → Settings → Telegram (bot status, Connect the bot, Link my Telegram); members: Profile → Telegram, or share their phone number with the bot. Test: `cd phase10-cloud/eval && ONLY=telegram npm run eval:masjid` (a fake Telegram; `VOICE=1` adds a voice note) |
| Ollama memory (Mac) | `OLLAMA_KEEP_ALIVE=1m`, set at login by `~/Library/LaunchAgents/local.ollama-keepalive.plist`: the 21 GB model leaves memory a minute after its last question (a cold load is 4.6 s). Quit Ollama from the menu bar when you are not running local evals |
| The masjid app end to end (made-up data) | `cd phase10-cloud/eval && npm run eval:masjid` (`VOICE=1` adds voice; `ONLY=chips` only the Malayalam ready questions - run those with the Groq settings; needs the masjid repo at `MASJID_REPO`) |
| The KMCC app end to end (made-up data) | `cd phase10-cloud/eval && npm run eval:kmcc` (`CONNECTOR=mcp`, `ONLY=telegram` or `ONLY=chips` - run those with the Groq settings; `DETAIL=1` prints whole failing answers). After a KMCC deploy is Ready: `npm run app -- add ../apps/kmcc-mcp.json` in `phase10-cloud/api` |
| Pause an app or cap its questions | Command Center unlocked with `ADMIN_KEY`: Connected apps · limits. Test: `cd phase10-cloud/eval && npm run eval:app-limits` |
| A key for a new app | `cd phase10-cloud/api && API_URL=https://ai-engineer-api-jet.vercel.app npm run app -- askkey new <name>` - works at once (also `askkey list`, `askkey revoke <id or name>`) |
| Ask like another app | `cd phase10-cloud/examples && npm run ask -- "your question"` (no question: a conversation) |
| Command Center (usage, cost, agents live) | live: https://ai-engineer-web-seven.vercel.app/#/command; local: http://localhost:5174/#/command (key: `DASHBOARD_KEY` or `ADMIN_KEY` in `.env`) |
| Deploy | `npx vercel deploy --prod` in `phase10-cloud/api` or `phase10-cloud/web` |

---

## 7. Where each step lives in git

`git show <commit>` shows exactly what changed in that step.

| Commit | Step |
|---|---|
| `413ffba` | Phase 2: talk to Ollama from code |
| `0402b21` | Phase 3: agent with tools |
| `f68c9c6` | Phase 4: MCP |
| `f2df4a8` | Phase 5: RAG |
| `110582c` | Phase 5.5: combined agent |
| `ad3b620` | Phase 7 shared core: config, retries, tracing, summaries |
| `a162039` | Phase 6 through 6.11: chat UI |
| `f01270e` | Phase 7: eval suite |
| `70cc1c6` | Phase 5.6: hybrid search |
| `e8be92a`, `bfd540e` | Phase 8a: LangChain Version A and B |
| `f82eae5` | Move to the M1 Max, bigger model, 8a re-run |
| `f4e6a72` | One-command startup script |
| `efea350` | Eval wording fix, small-model test |
| `0974760` | Phase 8b: multi-agent supervisor |
| `6f39782` | Phase 8b: LangGraph version |
| `396018e` | Phase 8c: multi-agent in the UI |
| `44727c6` | Phase 8c: manual specialist pick |
| `3a37379` | Phase 8c: fix answers leaking through history |
| `94043a2` | Phase 8c: fix two-part questions not being split |
| `787372f` | Phase 9.1: real corpus and retrieval baseline |
| `0cc4cfd` | Phase 9: chip shows what the document search led to |
| `53375cc` | Phase 9.2-9.6: cleaning, chunking, judged relevance, citations |
| `c088b90` | Phase 10a.1: self-contained copy in `phase10-cloud/` |
| `fa4ef8b` | Phase 10a.2: one model client for Ollama and Groq |
| `48a3a6e` | Phase 10a.3: connection settings, three silent failures fixed |
| `ccfc495` | Phase 10a.4: embeddings inside Node |
| `15245c6`, `298cd86` | Phase 10a.5: Neon, Upstash, follow-ups, two-model split |
| `486e74f` | Phase 10a.5: cheaper judging, fallback, clear limit message, router fix |
| `95da540`, `5c53de8` | Phase 10b.6: access code, deployed on Vercel |
| `eea812b`, `3d8e436` | Phase 10: JSON retry, two-way model fallback |
| `12cc872`, `28e86fc` | Phase 10: small talk skips search, rework requests |
| `0675f45`, `400f491` | Phase 10d.1: `POST /api/ask` for other apps, deployed |
| `fe6e3f6` | Phase 10d.1: example client for other apps |
| `4ee670b`, `7ab27af` | Phase 10d.2: long attachments, deployed |
| `6e005c0` | Phase 10d.3: data policy - which documents may go to which services |
| `6019c98` | Phase 10d.4: connected apps - answers from other applications' live data |
| `63f3258`, `cd00e5f` | Phase 10d.5: routing fixes; callers, users and roles (masjid repo: `c2d7cdb`, `fbb0286`) |
| `6a1f23d`, `e3d4d57`, `4129b76` | Phase 10d.6: voice for apps, `eval:masjid`, today's date in app results (masjid repo: `744c56c` limits, `2e75da3` phone UI, `33bfecc` voice and ₹, `061b97d` Malayalam names) |
| `47907ce`, `6d489d2` | Phase 10e: usage metering, the Command Center, top users (masjid repo: `f2317ef` who asks) |
| `92a920a`, `c7e83ac`, `d7a0c49`, `8e66b4c`, `ba7a2cb`, `93ca40f`, `d15aa47` | Phase 10e, later: phone voice, read-aloud on phones and in every language, usage questions, what failed, conversation mode, dates (masjid repo: `01d374e` dues by year) |
| `48ad8b9` | Phase 10d.7: app ask-keys in Redis, hashed |
| `2132350`, `edf5ae5` | Phase 10d.8: `eval:masjid` checks for last year's dues and the Malayalam ready questions (masjid repo: `a1ef56c` everyone's dues for a year, `0cec43b` the new look and Malayalam questions) |
| `4f95df4`, `d474218` | Phase 10d.9: the MCP connector type, `eval:mcp`, `eval:masjid` over MCP (masjid repo: `4d0c969` the MCP server at `/api/ai/mcp`) |
| `37dca3b` | Phase 10d.10: `eval:masjid` checks for personal MCP tokens (masjid repo: `37cbae3` personal MCP tokens in Settings) |
| `ba9e0c0` | Phase 10d.11: tables and charts in answers (masjid repo: `a16c824` the chat draws them) |
| - | Phase 10d.12, masjid repo branch `redesign-1`: `29b24d7` look step 1, `0395be0` About the masjid, `58b2c8e` photos in the app, `4d8d296` / `c4d32aa` / `16678ae` the other pages, `ed2f68a` the assistant page on phones, `75182bb` the dashboard's charts |
| `7fbd63e` | Phase 10d.13: `eval:masjid` Telegram checks against a fake Telegram (masjid repo: `256f15a` the Telegram bot and the dues-search fix, `2d4d0ec` the Profile spinner fix) |
| `d4e6993`, `1745f83` | Phase 10d.14: charts with several series, `eval:masjid` month and day checks, the Command Center greeting (masjid repo: `9e26b0f` month by month, charts, Copy / Image / Print; `11b3933` the 30-day and this-year cards) |
| `2edad18` | Phase 10d.15: rework for a pinned `connected_apps` agent, masjid-only checks (masjid repo: `3cf162d` masjid answers only, message times) |
| `bbc1826`, `5af1af2`, `f073d92`, `40e63ea` | Phase 10d.16: `eval:kmcc`, `apps/kmcc.json` and `kmcc-mcp.json` (KMCC repo: `ceb71fc` the assistant, Telegram and AI API; `563b77f` "my" as a search; `8e9c2f8` credit/debit statement; `2879691` profit and opening balance from descriptions, year by year) |
| `37f0dac` | Phase 10d.17: each app's switch and daily / monthly limits in the Command Center, `eval:app-limits` |

Phase 9 commits are on the `phase9-real-docs` branch. Phase 10 work happens on the `phase10-cloud`
branch, and `master` is fast-forwarded to it after each shipped step.
