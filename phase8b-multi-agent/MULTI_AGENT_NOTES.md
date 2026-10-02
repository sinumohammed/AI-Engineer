# Phase 8b: Multi-agent orchestration (hand-rolled)

Everything through Phase 8a is one agent: one model, one system prompt. This phase splits the work
across several agents and looks at what that costs and what breaks. Built 2026-10-02 on
`qwen3-coder:30b`, hand-rolled first (no framework), same as every earlier phase.

## What was built

A supervisor with three specialists. One question flows through up to three stages:

1. **Route** - one LLM call splits the message into tasks and assigns each to a specialist.
2. **Dispatch** - each task runs on its specialist.
3. **Combine** - one task: the specialist's answer is returned untouched. Several tasks: one more
   LLM call merges them.

| Specialist | Job |
|---|---|
| `company_docs` | Always-retrieve RAG, same retrieval and prompt wording as the single agent. If nothing relevant is found it refuses in code, with no model call. |
| `coding` | Programming, debugging, command-line questions. |
| `general` | General knowledge and questions about the conversation itself. |

The hand-off is **structured output, not tool calling**: the router's reply is constrained by a JSON
schema (`format` in Ollama's `/api/chat`), so the agent name is always one of the three and the JSON
always parses. Nothing in this phase sends `tools`.

## Results

| Test | `qwen3-coder:30b` | `gemma3:4b` (all roles) |
|---|---|---|
| Routing, 17 cases | 17/17 | 16/17 |
| Two-specialist answers, 3 cases | 3/3 | 3/3 |
| Single-agent regression suite (`phase7-reliability/eval.js`) | 7/7 | 7/7 |

Also checked a 3-turn conversation by hand: company question, then a coding follow-up, then "what
was the first thing I asked you?" - each went to the right specialist and the last one was answered
from history.

## The three coordination problems

### 1. Who decides which agent handles a question?

The first router read only the question's wording and the specialists' descriptions. It scored 14/15,
and the one failure is the important finding of this phase:

- **"How are rollbacks done?" went to `coding`.** There is no "our" in it, so the router called it a
  general software question. The company has a doc that answers it, and the single agent
  (always-retrieve) answers it correctly. **Splitting into agents introduced a regression the single
  agent did not have**: the router knows what each specialist is *for*, not what the documents
  *contain*.

Fix: run retrieval before routing and show the router the best excerpt as evidence. With that,
17/17 (two more trap cases were added at the same time, see below). `ROUTER_EVIDENCE=off` reproduces
the first router: 16/17, same failure.

A simpler fix was measured and rejected: "if vector distance is under `RELEVANCE_THRESHOLD`, send it
to `company_docs`" in code. Generic coding questions also land under the 0.5 threshold, because the
doc mentions commits and CI builds:

| Question | Distance | Should go to |
|---|---|---|
| How are rollbacks done? | 0.371 | `company_docs` |
| How do I set up a CI build with GitHub Actions? | 0.469 | `coding` |
| How do I revert a commit in git? | 0.493 | `coding` |
| How many minutes are there in a day? | 0.510 | `general` |

So the distance alone cannot separate them. The number is good enough to gate "is this excerpt worth
showing"; deciding whether the excerpt *answers* the question needs the model to read it. This is
different from Phase 7, where the same threshold was enough because there was only one agent and a
wrong "relevant" just meant an excerpt the model ignored.

### 2. How do results get combined?

- **One task (the usual case):** no synthesis call. An extra "polish" pass costs latency and can
  reword a correct answer into a wrong one, so the specialist's answer goes back as is.
- **Several tasks:** a synthesizer call merges them, told to use only what the specialists said and
  to keep refusals. The XJ-9999 + "Pride and Prejudice" case checks this: the merged answer must name
  Austen, must refuse the made-up code, and must not mention 2200 or 90 days.

### 3. How do you debug a chain of agents?

Every run writes one trace line (`phase5-rag/logs/traces.jsonl`, `architecture: "multi-agent"`) and
returns the same object: the router's reason, the evidence it saw, each task with the specialist's
answer, retrieval metadata and timing, and total LLM calls and tokens. The routing eval tests the
router alone, so a wrong hand-off is caught directly rather than guessed from a bad final answer -
that is how the "How are rollbacks done?" failure was found, with the router's own reason printed
next to it.

## What it costs

| | Single agent | Supervisor, one specialist | Supervisor, two specialists |
|---|---|---|---|
| LLM calls per question | 1 | 2 | 4 |
| Latency on `qwen3-coder:30b` | ~0.3-1.0s | ~1.5-2.3s | ~2.8-5.6s |

On the 7 regression questions the supervisor gives the same answers as the single agent at roughly
2-3x the latency. For this project's single-domain assistant, multi-agent is not a win on those
questions. What it adds is answering a message that mixes a company question with a coding or general
one, and giving each kind of question its own narrow prompt.

## Small model

With every role on `gemma3:4b` the supervisor still works: 16/17 routing, 3/3, 7/7. The one miss sent
"How do I set up a CI build with GitHub Actions?" to `general` instead of `coding`. Phase 8a's
Version B could not run on this model at all (`does not support tools`); this design can, because the
hand-off is structured output. `ROUTER_MODEL` and `SPECIALIST_MODEL` can be set separately (both
default to `CHAT_MODEL`); a mixed setup has not been tested.

## LangGraph version (`supervisor-graph.js`)

The same supervisor rebuilt with LangGraph (`@langchain/langgraph` 1.4.18), same approach as Phase 8a:
reuse everything except the part under test. Prompts, schema, validation (`routing.js`), specialists
and retrieval (`specialists.js`) are shared, so only the orchestration differs. Model calls go
through `ChatOllama` instead of `llm.js`.

How the hand-rolled pieces map onto the graph:

| Hand-rolled (`supervisor.js`) | LangGraph (`supervisor-graph.js`) |
|---|---|
| local variables inside `runAgent` | one shared state object (`Annotation.Root`) that nodes read and write |
| three stages called in order | three nodes: `router` -> `specialist` -> `combine`, joined by edges |
| `Promise.all(tasks.map(...))` | a conditional edge returning one `Send("specialist", ...)` per task |
| result array + the `count()` closure | reducers on `steps` and `usage` that merge parallel writes |
| `chat({ format: ROUTE_SCHEMA })` + `JSON.parse` | `withStructuredOutput(ROUTE_SCHEMA, { method: "jsonSchema", includeRaw: true })` |

**Results: identical.** Same evals, pointed at the graph via `SUPERVISOR_MODULE` / `AGENT_MODULE`:

| Test | Hand-rolled | LangGraph |
|---|---|---|
| Routing, 17 cases (`qwen3-coder:30b`) | 17/17 | 17/17 |
| Two-specialist answers | 3/3 | 3/3 |
| Single-agent regression suite | 7/7 | 7/7 |
| Whole routing + end-to-end eval, wall time | ~37s | ~38s |
| All roles on `gemma3:4b` | 16/17, 3/3, 7/7 | 16/17, 3/3, 7/7 (same one miss) |

No measurable latency overhead from the framework. (One hand-rolled eval run took 6 minutes instead
of ~37s; a re-run was normal and the cause was not identified.)

**What the framework gave:**
- Parallel fan-out and merging the results are built in (`Send` + reducers).
- A diagram of the flow generated from the code: `npm run ask:graph -- --diagram` prints Mermaid text.
- Features not used here but available without restructuring: a checkpointer (per-thread memory and
  resuming a run), streaming each node's update as it finishes, pausing for human approval.

**What it cost:**
- More code for this size of problem: 119 lines vs 89 (comments and blanks excluded), plus 63MB of
  `node_modules` where the hand-rolled version has no dependencies of its own.
- New concepts before the first line works: state, reducers, conditional edges, `Send`.
- A node started by `Send` receives only the `Send` payload, not the shared state - so `history` has
  to be passed explicitly. Easy to miss: the specialist would just run with no conversation history.
- Token usage is lost on a structured-output call unless `includeRaw: true` is set.
- `withStructuredOutput`'s `method` has to be the right one. Verified on `gemma3:4b`: `"jsonSchema"`
  works; `"functionCalling"` fails with `does not support tools`. `"jsonSchema"` is the default in
  `@langchain/ollama` 1.3.0, but it is set explicitly so a changed default cannot silently turn the
  router into a tool call - the Phase 8a lesson about silently-ignored options, applied in advance.

**Conclusion:** unlike Phase 8a's Version B, nothing broke - the LangGraph version worked on the
first run and matches the hand-rolled one case for case. For a three-node, one-direction flow it is
more code and more concepts for the same result, so hand-rolled is the simpler choice at this size.
The framework starts to pay for itself when the flow has loops, needs to pause and resume, or needs
per-thread memory - none of which this supervisor has.

## Second-hand answers: a multi-agent bug the single agent cannot have

Found in the chat UI (Phase 8c) by picking a specialist manually. Every specialist gets the
conversation history. If an earlier turn was answered from the company documents, `general` and
`coding` - which never see documents - could repeat those facts from the history, and present them as
"based on the company documents".

- **Prompt instruction: no effect.** 4 of 4 forced answers still repeated the rollback process.
- **Structural fix: works.** Answers that used a document excerpt are stored with a
  `fromCompanyDocs` tag, and `historyFor()` replaces them with a placeholder for specialists without
  document access. 4 of 4 then say they have no access; the user's own messages stay visible.

This is a coordination problem specific to several agents sharing one memory: **what one agent
learned leaks to another agent through the shared history.** The single agent has no such boundary to
protect - it always has the documents. `npm run eval` covers it ("Second-hand answers", 4 cases).

Known gap: the running summary of older turns (Phase 6.11) is not redacted.

## Not done

- ~~The Phase 6 UI still uses the single agent~~ - done as Phase 8c: the chat UI has a
  "Single agent / Multi-agent" switch (hand-rolled supervisor). See ROADMAP.md.
- Conversation summaries are passed to the hand-rolled supervisor's specialists (8c), not to the
  router and not to the LangGraph version.
- The LangGraph version does not use the checkpointer; history is passed in, as in the hand-rolled one.
- No "agents as tools" variant, where one agent calls another mid-answer.
- Retrieval runs twice for a company question (once for the router's evidence, once in the
  specialist). Cheap at this corpus size, not optimized.
## Files

| File | Purpose |
|---|---|
| `supervisor.js` | Hand-rolled orchestration: route, dispatch, combine, trace. `npm run ask -- "question"` |
| `supervisor-graph.js` | The same supervisor as a LangGraph graph. `npm run ask:graph -- "question"` |
| `routing.js` | Shared by both: router prompt, schema, document evidence, validation, synthesizer prompt |
| `specialists.js` | Shared by both: the three specialists and the retrieval gate |
| `llm.js` | The hand-rolled chat call, with optional JSON-schema `format` |
| `eval.js` | Routing cases + two-specialist end-to-end cases. `npm run eval` / `npm run eval:graph` |
| `package.json` | `npm run eval:regression` / `eval:regression:graph` run `phase7-reliability/eval.js` against a supervisor |
