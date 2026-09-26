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

## Files

| File | Purpose |
|---|---|
| `agent-a.js` | Version A — classic RAG replica |
| `agent-b.js` | Version B — agentic RAG via `createAgent` |
| `package.json` | `@langchain/core`, `@langchain/ollama`, `langchain` |

`phase7-reliability/eval.js` was parameterized (`AGENT_MODULE` env var) rather than forked, so all
three implementations (hand-rolled, Version A, Version B) run through one shared pass/fail record.
