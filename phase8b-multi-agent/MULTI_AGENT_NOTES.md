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

## Not done

- The Phase 6 UI still uses the single agent; the supervisor is CLI and eval only.
- No framework version (e.g. LangGraph) to compare against, as 8a did for the single agent.
- No "agents as tools" variant, where one agent calls another mid-answer.
- Retrieval runs twice for a company question (once for the router's evidence, once in the
  specialist). Cheap at this corpus size, not optimized.
- Conversation summaries (Phase 6.11) are not passed to the supervisor, only recent history.

## Files

| File | Purpose |
|---|---|
| `supervisor.js` | Router, dispatch, synthesis, trace. `npm run ask -- "question"` |
| `specialists.js` | The three specialists and the shared retrieval gate |
| `llm.js` | One chat call for every role, with optional JSON-schema `format` |
| `eval.js` | Routing cases + two-specialist end-to-end cases. `npm run eval` |
| `package.json` | `npm run eval:regression` runs `phase7-reliability/eval.js` against the supervisor |
