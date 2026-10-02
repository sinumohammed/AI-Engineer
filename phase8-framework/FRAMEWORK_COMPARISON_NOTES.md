# Phase 8a — LangChain.js vs. the hand-rolled agent

Goal: rebuild the same combined agent (Phase 5.5: general knowledge + `search_company_docs`) using
LangChain.js, and compare directly against `phase5-rag/agent.js` / `phase6-ui/server/agent.js`. Both
versions reuse the SAME retrieval logic (`phase5-rag/tools.js`, including the Phase 5.6 hybrid search
fix) and the SAME config (`phase5-rag/config.js`) — the only variable under test is the agent
implementation itself.

Both versions were run through the exact same eval harness (`phase7-reliability/eval.js`, now
parameterized via `AGENT_MODULE`), against the same 7 regression cases used to validate the
hand-rolled agent.

## Version A — "classic RAG" replica (`agent-a.js`)

Matches the hand-rolled design exactly: retrieval always runs first, results are baked into the system
prompt, then a single `ChatOllama.invoke()` call answers. No tool loop, no model-driven tool choice.

**Result: 7/7 passed** — identical correctness to the hand-rolled agent, including both Phase 5.6
hybrid-search regression cases (XJ-2200 answered correctly, XJ-9999 correctly refused).

**What LangChain abstracted away, confirmed by reading its source (not assumed):**

| Concern | Hand-rolled (`phase5-rag/agent.js`) | LangChain (`agent-a.js`) |
|---|---|---|
| HTTP call + JSON parsing | `fetch()` + `res.ok` check + `res.json()` | `model.invoke()` — one call, typed `AIMessage` back |
| Retries on transient failures | Hand-written `retry.js` / `withRetry` (exponential backoff, skips 4xx) | Built into `@langchain/core`'s `AsyncCaller` — `maxRetries` defaults to **6**, with the same "don't retry 4xx-style errors" logic (confirmed by reading `async_caller.js`'s `defaultFailedAttemptHandler`) |
| Token usage reporting | Manually read `data.prompt_eval_count` / `data.eval_count` off the raw fetch response | `response.usage_metadata` (normalized `input_tokens`/`output_tokens`) **and** Ollama's raw `prompt_eval_count`/`eval_count` passed through untouched on `response.response_metadata` — strictly more, not less |

**What it did NOT need to abstract:** the turn loop, `extractJsonObjects`/`extractToolCalls` fallback
parsing — because Version A never gives the model a tool to call in the first place (always-retrieve
design). That comparison only becomes relevant in Version B.

**A real bug hit while building this (not LangChain's fault, ours):** the standard ESM
"is this the main module" check (`import.meta.url === \`file://${process.argv[1]}\``) silently breaks
on Windows, because `process.argv[1]` uses backslashes while `import.meta.url` doesn't — the CLI block
just never ran, no error, no output. Fixed with `pathToFileURL(process.argv[1]).href`, and guarded for
`process.argv[1]` being `undefined` when the module is imported programmatically (needed so
`eval.js`'s dynamic `import()` doesn't crash on that same line).

## Version B — "agentic RAG" via LangChain's `createAgent` (`agent-b.js`)

Deliberately rebuilds the design Phase 6.8 moved AWAY from by hand: the model decides whether to call
`search_company_docs`, using LangChain v1's `createAgent` (a ReAct-style loop; the old `AgentExecutor`
API from older LangChain tutorials no longer exists in v1 — this project used `langchain@1.5.12`).
Added `toolCallLimitMiddleware({ runLimit: 5, exitBehavior: "end" })` as the direct equivalent of our
hand-rolled `MAX_TURNS` cap (Phase 7 Bug 4 was an unbounded tool loop — this closes the same gap
proactively rather than after hitting it).

**Result: 0/7 passed.** Every single question — all 4 company questions AND the general-knowledge
"capital of France" question — failed the same way. The model correctly decided a tool call was needed
(even for "capital of France," which is itself a known looseness of this quantized model once tool
schemas are present — see Phase 7 Bug 4's `get_current_time` looping), but instead of using Ollama's
structured `tool_calls` response field, it dumped the call as raw JSON text into the answer:

```
{"name": "search_company_docs", "arguments": {"query": "rollback process"}}
```

**Root cause, verified directly (not assumed):**
- Called `model.bindTools([...]).invoke(...)` directly, bypassing `createAgent` entirely, and got the
  same result: `tool_calls: []`, with the JSON dumped into `content`. This is a **model-level quirk**,
  not something `createAgent` introduced.
- This is the *exact same failure mode* `phase5-rag/agent.js` was written to survive back in Phase 3 —
  `qwen2.5-coder:7b-instruct-q4_K_M` sometimes skips Ollama's `tool_calls` field and just writes the
  call as plain JSON text instead. Our hand-rolled agent has `extractJsonObjects`/`extractToolCalls` —
  a fallback that scrapes JSON out of `content` specifically to survive this.
- Checked `@langchain/ollama`'s source directly (`grep` for `tool_call` handling in
  `chat_models.cjs`): **no equivalent fallback exists.** It only trusts Ollama's native
  `message.tool_calls` field. When the model doesn't populate it, LangChain has no recovery path — the
  raw JSON is treated as the final answer.

**The honest conclusion:** this is not "LangChain is buggy" — it's that LangChain's tool-calling
abstraction assumes the underlying model reliably populates the provider's native tool-calling field,
which this specific quantized local model does not always do. Our hand-rolled fallback for this exact
gap already existed (Phase 3) before Phase 8 even started. LangChain's `createAgent` gives you the loop,
the iteration limit, and the message-history bookkeeping for free — but it does NOT give you resilience
against a small model's flaky tool-calling output, and there's no clean interception point in
`createAgent`'s loop to bolt that fallback on without either monkey-patching the model class or writing
a custom wrapper — which would just re-derive the exact code Phase 3 already wrote by hand.

**Deliberately not chased further** (decision made explicitly, not by default): patching around this
would mean re-implementing `extractToolCalls` inside a LangChain wrapper, which defeats the point of
testing the framework's own abstraction. Documented as a limitation instead — consistent with this
project's established practice (e.g. Phase 6.11's refusal-bias limitation, the retry-timing race in
Phase 7) of recording an honest "this doesn't work, and here's exactly why" rather than chasing every
finding to a fix.

## Answering the actual Phase 8a question: is the abstraction worth it here?

- **For "classic" always-retrieve RAG (Version A): yes, mildly.** LangChain gives real, verified value
  (built-in retries, richer token-usage reporting, less boilerplate) at essentially zero cost, because
  this design never exercises the part of LangChain that's fragile for this model.
- **For agentic tool-choice (Version B): no, not for this model.** The framework's loop abstraction is
  actively worse than the hand-rolled version for this project's specific constraint (a small quantized
  local model with unreliable native tool-calling) — it removes exactly the escape hatch
  (`extractToolCalls`) that Phase 3 proved necessary, with no way to add it back cleanly.
- This also validates, from a completely different angle, the Phase 6.8 architecture decision:
  always-retrieve RAG isn't just more reliable than agentic tool-choice for THIS model when hand-rolled
  — it's the ONLY one of the two designs that survives being ported to a framework at all, on this
  hardware.

## Re-run on bigger models (2026-09-30, after moving to an M1 Max / 32GB Mac)

The Version B conclusion above was explicitly tied to "this model, on this hardware" - so once the
project moved from the Windows laptop (GTX 1050 Ti, 4GB VRAM) to an M1 Max with 32GB unified memory,
it could finally be tested against models that were never an option before. Same eval harness, same 7
cases, same retrieval/config - only `CHAT_MODEL` changed (via `phase5-rag/.env`), with `NUM_CTX=32768`
(both models fit 100% on GPU at that size, verified with `ollama ps`).

| Agent | `qwen2.5-coder:7b` (old, Windows) | `qwen3-coder:30b` | `qwen3.5:27b` |
|---|---|---|---|
| Hand-rolled (`phase6-ui/server/agent.js`) | 7/7 | **7/7**, ~0.5s/answer | 6/7, ~40s/answer |
| Version A (`agent-a.js`) | 7/7 | **7/7**, ~0.4s | 6/7, ~40s |
| Version B (`agent-b.js`) | 0/7 | 4/7, ~1.3s | 4/7, ~22s |

**Version B's 0/7 was the model, not only the framework - verified, not assumed.** Logged
`toolCallLog` for each question on `qwen3-coder:30b`: every company question produced a real,
structured `search_company_docs` call through Ollama's native `tool_calls` field, and "capital of
France" correctly made no call at all. No JSON-in-`content` dumps. So `@langchain/ollama`'s missing
fallback only mattered because the old model needed one - with a model that populates `tool_calls`
reliably, `createAgent` works as intended. Still no `extractToolCalls`-style fallback added (same
reasoning as above).

**Every remaining failure is a correct answer in different wording - not a wrong fact:**
- Version B, both models: "Monday at **10 AM**" / "**10:00 AM**" (eval wants `10am`); refusals worded
  as "search results do not contain specific information…" / "I couldn't find…" / "unable to find…"
  (eval wants `don't know` / `don't have information`).
- Hand-rolled and Version A on `qwen3.5:27b`: "I **do not** have information…" (eval wants
  `don't have information`).

**Root cause of Version B's 3 failures: its system prompt, not the tool loop.** The hand-rolled agent
(`agent.js:185`, `:191`) and Version A (`agent-a.js:37`, `:43`) both tell the model to "say plainly that
you don't have information about that specific identifier" / "say plainly that you don't know".
Version B's `createAgent` prompt only says *when* to call the tool - never how to refuse - so the model
picks its own phrasing. So the original comparison wasn't fully controlled: Version B differed from the
other two in prompt as well as architecture. (Turned out to be worse than that - see "Prompt parity fix"
below: Version B's prompt wasn't reaching the model at all.)

**One small real bug on `qwen3-coder:30b`:** one Version B answer ended with a stray `<tool_call>` text
token after an otherwise correct refusal - a milder cousin of the original JSON-in-`content` leak.

**Why `qwen3.5:27b` is ~80x slower despite a similar size:** `qwen3-coder:30b` is mixture-of-experts
(30.5B total, only ~3B active per token); `qwen3.5:27b` is dense (all 27.8B used for every token) AND
has thinking enabled by default (`ollama show`) - hidden reasoning tokens before every answer, and none
of our agents pass `think: false`. No accuracy gain on this eval to justify it, so `qwen3-coder:30b` is
the new default.

**Also learned - the eval is brittle to model upgrades:** exact-substring checks (`10am`,
`don't know`) passed on the small model partly because it repeated the prompt's exact phrases
literally. Larger models paraphrase more freely, so correct answers can fail on formatting alone.

### Prompt parity fix - and a bigger bug it exposed: Version B never had a system prompt

Added the same answering/refusal wording as Version A to Version B's prompt, then re-ran. **The
answers came back word-for-word identical to before** - a prompt change with literally zero effect
on a temperature-0 model means the prompt isn't reaching it. Checked `langchain@1.5.12`'s source:
`createAgent` only reads **`options.systemPrompt`** at runtime (`dist/agents/ReactAgent.js:96`,
`normalizeSystemPrompt(this.options.systemPrompt)`); the `prompt` key `agent-b.js` was passing is
silently ignored - no error, no warning. The trap: `createAgent`'s own JSDoc in `index.d.ts` still
documents `@param options.prompt - System instructions`, while the actual type (`types.d.ts`) only
declares `systemPrompt`. Since `agent-b.js` is plain JS, nothing type-checked it.

**Consequence: every Version B run before 2026-09-30 - including the original 0/7 - ran with no
system prompt at all.** That doesn't change the 0/7's diagnosis (the JSON-in-`content` dumps were
verified at the `bindTools().invoke()` level, bypassing `createAgent` entirely), but the "for general
knowledge questions, answer directly" instruction was never in play either.

After renaming `prompt` → `systemPrompt` (`qwen3-coder:30b`, 2 runs, identical results):

| | Before (no system prompt) | After (`systemPrompt`, prompt parity) |
|---|---|---|
| Version B | 4/7 | **6/7** |

"10 AM" became "10am" and the XJ-9999 refusal now says "don't have information" - both instructions
the model had simply never received. The one remaining failure: the backup-schedule refusal is correct
("The search results do not contain information about the database backup schedule…") but still not
phrased as "don't know", and it still ends with the stray `<tool_call>` token. Deliberately not tuned
further - pushing the prompt harder for one exact phrase would be teaching to the test.

A likely reason this one case differs: Version A and the hand-rolled agent put the retrieved excerpt
and the refusal instruction together in ONE system message built per question, while Version B's
instruction sits in a generic up-front prompt and the "no relevant results" evidence arrives later as
a tool message - so the instruction is further from the moment it applies.

**Updated conclusion:** the "Version B: no, not for this model" verdict above still holds for
`qwen2.5-coder:7b`, but it was a model limitation more than a framework one. With a model that has
reliable native tool-calling AND a system prompt that actually reaches it, LangChain's agentic loop
gets 6/7 (7/7 on facts) versus 7/7 for always-retrieve. New framework lesson, arguably the most
useful one from Phase 8a: **a framework option that's silently ignored is worse than an error** - the
hand-rolled agent can't have this bug, because there is no config object to misname.

**Next steps (not done yet):**
1. Consider loosening eval matching (case/space-insensitive times, accepting `do not know` alongside
   `don't know`) - weighed against keeping the regression tests strict.
2. Strip stray `<tool_call>` tokens from Version B's final answer? Would be a small post-processing
   step - but it's the same category of fallback deliberately left out of Version B, so needs a
   decision rather than a default.

## Files

| File | Purpose |
|---|---|
| `agent-a.js` | Version A — classic RAG replica |
| `agent-b.js` | Version B — agentic RAG via `createAgent` |
| `package.json` | `@langchain/core`, `@langchain/ollama`, `langchain` |

`phase7-reliability/eval.js` was parameterized (`AGENT_MODULE` env var) rather than forked, so all
three implementations (hand-rolled, Version A, Version B) run through one shared pass/fail record.
