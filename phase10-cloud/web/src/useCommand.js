import { useRef, useState } from "react";
import { API_BASE } from "./useChatSession.js";
import { AGENT_LABELS } from "./Sidebar.jsx";

// Phase 10e: one question from the Command Center, asked through the same
// multi-agent stream as the web chat (/api/chat/stream?mode=multi), in its
// own conversation so it never mixes with the chat's. The stream's events
// become a live picture of the agents at work:
//   route        - the router's decision: which specialists, with what task
//   agent_start  - a specialist (or the combiner) starts
//   agent_done   - ...and finishes, with its time
//   answer_chunk - the answer arriving
// and a log, written as the agents talking to each other.

const label = (agent) => AGENT_LABELS[agent] ?? agent;

function sessionId() {
  try {
    let id = localStorage.getItem("commandSessionId");
    if (!id) {
      id = `command-${crypto.randomUUID()}`;
      localStorage.setItem("commandSessionId", id);
    }
    return id;
  } catch {
    return `command-${crypto.randomUUID()}`;
  }
}

const idle = { phase: "idle", question: "", answer: "", tasks: [], agents: {}, combining: false, log: [], usage: null, error: null, startedAt: null, finishedAt: null };

export function useCommand({ accessCode, onDone }) {
  const [run, setRun] = useState(idle);
  const latest = useRef(idle);
  const es = useRef(null);
  const sid = useRef(sessionId());

  // Kept in a ref as well, so "done" can hand the finished run on without a
  // side effect inside a state updater (React may run those twice).
  const update = (fn) => {
    latest.current = fn(latest.current);
    setRun(latest.current);
  };
  const say = (r, from, to, text) => ({ ...r, log: [...r.log, { from, to, text, at: Date.now() }] });

  function ask(question) {
    es.current?.close();
    const q = question.trim();
    if (!q) return;
    update(() => say({ ...idle, phase: "routing", question: q, startedAt: Date.now() }, "You", "Router", q));
    const code = accessCode ? `&code=${encodeURIComponent(accessCode)}` : "";
    const source = new EventSource(`${API_BASE}/api/chat/stream?sessionId=${encodeURIComponent(sid.current)}&mode=multi${code}&q=${encodeURIComponent(q)}`);
    es.current = source;
    const on = (name, fn) => source.addEventListener(name, (e) => fn(e.data ? JSON.parse(e.data) : {}));

    on("route", (d) =>
      update((r) => {
        let next = { ...r, phase: "working", tasks: d.tasks ?? [] };
        if (d.reason) next = say(next, "Router", null, d.reason);
        for (const t of d.tasks ?? []) next = say(next, "Router", label(t.agent), t.question);
        return next;
      })
    );
    on("agent_start", (d) =>
      update((r) => {
        if (d.agent === "synthesizer") return say({ ...r, combining: true }, "Combiner", null, `Merging ${r.tasks.length} answers into one`);
        return { ...r, agents: { ...r.agents, [d.agent]: { status: "running" } } };
      })
    );
    on("agent_done", (d) =>
      update((r) => {
        if (d.agent === "synthesizer") return { ...r, combining: "done" };
        const secs = d.latencyMs != null ? ` in ${(d.latencyMs / 1000).toFixed(1)} s` : "";
        return say({ ...r, agents: { ...r.agents, [d.agent]: { status: "done", latencyMs: d.latencyMs } } }, label(d.agent), r.tasks.length > 1 ? "Combiner" : "You", `Answer ready${secs}`);
      })
    );
    on("notice", (d) => update((r) => say(r, "System", null, d.text)));
    on("answer_chunk", (d) => update((r) => ({ ...r, phase: "answering", answer: r.answer + d.text })));
    on("usage", (d) => update((r) => ({ ...r, usage: d })));
    on("done", () => {
      source.close();
      update((r) => ({ ...r, phase: "done", finishedAt: Date.now() }));
      onDone?.(latest.current);
    });
    source.addEventListener("error", (e) => {
      source.close();
      let message = null;
      try {
        message = e.data ? JSON.parse(e.data).message : null;
      } catch {
        // a lost connection carries no message
      }
      update((r) => say({ ...r, phase: "error", error: message ?? "Connection lost - check the internet connection and try again.", finishedAt: Date.now() }, "System", null, message ?? "Connection lost"));
    });
  }

  function cancel() {
    es.current?.close();
    update((r) => (r.phase === "done" || r.phase === "idle" ? r : { ...r, phase: "error", error: "Stopped.", finishedAt: Date.now() }));
  }

  async function forget() {
    es.current?.close();
    const old = sid.current;
    sid.current = `command-${crypto.randomUUID()}`;
    try {
      localStorage.setItem("commandSessionId", sid.current);
    } catch {
      // storage blocked: a new conversation for this page only
    }
    update(() => idle);
    fetch(`${API_BASE}/api/chat/session/${encodeURIComponent(old)}`, { method: "DELETE", headers: accessCode ? { "x-access-code": accessCode } : {} }).catch(() => {});
  }

  return { run, ask, cancel, forget };
}
