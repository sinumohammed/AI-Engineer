# AI Engineer project: learning guide

A step-by-step walk through everything built in this project, from the first local model call to a
multi-agent chat app working over a real 241-page handbook. Written to be read top to bottom.

- **This guide** is the simple version: what each step is, how the flow works, what changed and why.
- **`ROADMAP.md`** is the detailed log: every experiment, number and dead end.
- **Notes files** go deep on one topic: `phase5-rag/HYBRID_SEARCH_NOTES.md`,
  `phase8-framework/FRAMEWORK_COMPARISON_NOTES.md`, `phase8b-multi-agent/MULTI_AGENT_NOTES.md`.

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

The system as it stands today:

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

Where things stand:

| Test | Result |
|---|---|
| Single agent, 7 cases | 7/7 |
| LangChain Version A and B, 7 cases | 7/7 each |
| Supervisor routing, 24 cases | 24/24 (hand-written and LangGraph) |
| Supervisor two-part answers | 3/3 |
| Supervisor history leak cases | 4/4 |
| Supervisor on the 7 single-agent cases | 7/7 |
| Retrieval, 37 cases: answer reaches the agent | 34/37 |
| Retrieval, off-topic questions wrongly treated as relevant | 0/8 |
| Citations: document answers that cite a source | 37/37 (single and multi-agent) |

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
   specific thing worked. Measure either way.
2. **Let code decide when it has a reliable signal, and re-check the signal when the data changes.**
   Relevance by vector distance (Phase 7) was a reliable code rule at 2 chunks and failed at 4,288.
   It was replaced by the model's judgement (9.4), which in turn feeds a code rule
   (`applyDocPriority`, 9.6).
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
    21 GB one, and size mattered when the model had to choose and call tools. That was measured on
    the 2-document corpus and has not been re-tested on the handbook.

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

Commits up to `eb72eb0` are on `master`. Phase 9 commits are on the `phase9-real-docs` branch.
