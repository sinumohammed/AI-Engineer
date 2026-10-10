import { useEffect, useReducer, useRef, useState } from "react";

// Phase 10: where the API is, from VITE_API_BASE in phase10-cloud/.env (see
// vite.config.js) or the host's build settings. Read at build time, so a
// change needs a restart of `npm run dev` or a new build. An empty value
// means the same site as the page, for when one host serves both.
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3002";

// Phase 10 step 6: the access code a hosted API asks for (ACCESS_CODE on the
// server), remembered in this browser once entered. Sent as a header, and as
// ?code= on the answer stream, which cannot send headers.
function storedCode() {
  try {
    return localStorage.getItem("accessCode") ?? "";
  } catch {
    return "";
  }
}
const codeHeaders = () => (storedCode() ? { "x-access-code": storedCode() } : {});

function getOrCreateSessionId() {
  let id = localStorage.getItem("sessionId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sessionId", id);
  }
  return id;
}

// Stored Redis history is [{role, content}, ...] turns with no tool-call
// detail (that's scratch work, never persisted - see agent.js). Restoring
// it into display bubbles just means pairing them back into user/assistant
// messages, with no tool log (we don't know what ran) and no per-message
// usage (only the session's last-known usage, attached to the newest one).
function historyToMessages(history, lastUsage) {
  const messages = history.map((turn) => ({
    role: turn.role,
    text: turn.content,
    tools: [],
    agents: [],
    route: null,
    usage: null,
  }));
  const lastAssistant = messages.filter((m) => m.role === "assistant").at(-1);
  if (lastAssistant) lastAssistant.usage = lastUsage;
  return messages;
}

function reducer(state, action) {
  switch (action.type) {
    case "LOAD":
      return { ...state, messages: action.messages, usage: action.usage, memory: action.memory ?? state.memory, loaded: true };
    case "ASK_START":
      return {
        ...state,
        busy: true,
        messages: [
          ...state.messages,
          { role: "user", text: action.question },
          { role: "assistant", text: "", tools: [], agents: [], route: null, usage: null },
        ],
      };
    case "TOOL_CALL":
      return { ...state, messages: updateLast(state.messages, (m) => ({ ...m, tools: [...m.tools, { name: action.name, args: action.args, status: "calling" }] })) };
    case "TOOL_RESULT":
      return {
        ...state,
        messages: updateLast(state.messages, (m) => ({
          ...m,
          tools: m.tools.map((t) =>
            t.name === action.name && t.status === "calling" ? { ...t, status: "done", outcome: action.outcome } : t
          ),
        })),
      };
    // Phase 8c (multi-agent mode): the supervisor's routing decision, then
    // each specialist starting and finishing. `index` identifies a step, so
    // two tasks sent to the same specialist stay separate chips.
    case "ROUTE":
      return {
        ...state,
        messages: updateLast(state.messages, (m) => ({
          ...m,
          route: { reason: action.reason, fallback: action.fallback, manual: action.manual },
        })),
      };
    case "AGENT_START":
      return {
        ...state,
        messages: updateLast(state.messages, (m) => ({
          ...m,
          agents: [...m.agents, { index: action.index, agent: action.agent, question: action.question, status: "running" }],
        })),
      };
    case "AGENT_DONE":
      return {
        ...state,
        messages: updateLast(state.messages, (m) => ({
          ...m,
          agents: m.agents.map((a) => (a.index === action.index ? { ...a, status: "done", latencyMs: action.latencyMs } : a)),
        })),
      };
    // Phase 9.6: which document sections the answer cited
    case "SOURCES":
      return { ...state, messages: updateLast(state.messages, (m) => ({ ...m, sources: action.sources })) };
    // Phase 10: notes from the server about how this answer was made
    case "NOTICE":
      return { ...state, messages: updateLast(state.messages, (m) => ({ ...m, notices: [...(m.notices ?? []), action.text] })) };
    case "SET_MODE":
      return { ...state, mode: action.mode };
    case "SET_AGENT":
      return { ...state, agent: action.agent };
    case "ANSWER_CHUNK":
      return { ...state, messages: updateLast(state.messages, (m) => ({ ...m, text: m.text + action.text })) };
    case "USAGE":
      return { ...state, usage: action.usage, messages: updateLast(state.messages, (m) => ({ ...m, usage: action.usage })) };
    case "MEMORY":
      return { ...state, memory: action.memory };
    case "DONE":
      return { ...state, busy: false };
    case "ERROR":
      return {
        ...state,
        busy: false,
        messages: updateLast(state.messages, (m) => ({ ...m, text: m.text || action.message })),
      };
    case "RESET":
      return { messages: [], usage: null, memory: null, busy: false, loaded: true, sessionId: action.sessionId, mode: state.mode, agent: "auto" };
    default:
      return state;
  }
}

function updateLast(messages, updater) {
  const copy = [...messages];
  copy[copy.length - 1] = updater(copy[copy.length - 1]);
  return copy;
}

export function useChatSession() {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    usage: null,
    memory: null,
    busy: false,
    loaded: false,
    sessionId: getOrCreateSessionId(),
    // "single" = the Phase 6 agent, "multi" = the Phase 8b supervisor.
    // Remembered across refreshes, like the session id.
    mode: localStorage.getItem("agentMode") === "single" ? "single" : "multi",
    // Manual override for multi-agent mode: "auto" lets the router decide,
    // a specialist's name skips the router. Deliberately NOT remembered
    // across refreshes or new chats - a forgotten override would keep
    // sending later questions to the wrong specialist.
    agent: "auto",
  });
  const esRef = useRef(null);
  // { needed, wrong }: whether to show the access-code form, and whether the
  // last code entered was rejected.
  const [access, setAccess] = useState({ needed: false, wrong: false });

  function loadSession() {
    fetch(`${API_BASE}/api/chat/session/${state.sessionId}`, { headers: codeHeaders() })
      .then((r) => r.json())
      .then(({ history, usage, memory }) => dispatch({ type: "LOAD", messages: historyToMessages(history, usage), usage, memory }))
      .catch(() => dispatch({ type: "LOAD", messages: [], usage: null }));
  }

  // Ask the API whether a code is needed and whether ours is right, before
  // loading the conversation. An API without ACCESS_CODE answers ok.
  async function checkAccess() {
    try {
      const r = await fetch(`${API_BASE}/api/access`, { headers: codeHeaders() });
      const { ok } = await r.json();
      return ok;
    } catch {
      return true; // unreachable API: let the normal connection error show
    }
  }

  useEffect(() => {
    checkAccess().then((ok) => {
      if (ok) loadSession();
      else setAccess({ needed: true, wrong: Boolean(storedCode()) });
    });
    // sessionId is stable for the lifetime of this hook instance (new instance after newChat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitCode(code) {
    try {
      localStorage.setItem("accessCode", code.trim());
    } catch {
      // storage blocked: the code cannot be remembered, so it cannot be sent
    }
    if (await checkAccess()) {
      setAccess({ needed: false, wrong: false });
      loadSession();
    } else {
      setAccess({ needed: true, wrong: true });
    }
  }

  function ask(question) {
    dispatch({ type: "ASK_START", question });

    const override = state.mode === "multi" && state.agent !== "auto" ? `&agent=${state.agent}` : "";
    const code = storedCode() ? `&code=${encodeURIComponent(storedCode())}` : "";
    const url = `${API_BASE}/api/chat/stream?sessionId=${state.sessionId}&mode=${state.mode}${override}${code}&q=${encodeURIComponent(question)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("route", (e) => dispatch({ type: "ROUTE", ...JSON.parse(e.data) }));
    es.addEventListener("agent_start", (e) => dispatch({ type: "AGENT_START", ...JSON.parse(e.data) }));
    es.addEventListener("agent_done", (e) => dispatch({ type: "AGENT_DONE", ...JSON.parse(e.data) }));
    es.addEventListener("tool_call", (e) => dispatch({ type: "TOOL_CALL", ...JSON.parse(e.data) }));
    es.addEventListener("tool_result", (e) => dispatch({ type: "TOOL_RESULT", ...JSON.parse(e.data) }));
    es.addEventListener("answer_chunk", (e) => dispatch({ type: "ANSWER_CHUNK", ...JSON.parse(e.data) }));
    es.addEventListener("sources", (e) => dispatch({ type: "SOURCES", sources: JSON.parse(e.data) }));
    es.addEventListener("usage", (e) => dispatch({ type: "USAGE", usage: JSON.parse(e.data) }));
    es.addEventListener("memory", (e) => dispatch({ type: "MEMORY", memory: JSON.parse(e.data) }));
    es.addEventListener("notice", (e) => dispatch({ type: "NOTICE", ...JSON.parse(e.data) }));
    es.addEventListener("done", () => {
      es.close();
      dispatch({ type: "DONE" });
    });
    // Two different things arrive as "error": the server's own error event,
    // which carries a message (e.g. a daily model limit - Phase 10), and the
    // browser's lost-connection error, which carries none. Before, both
    // showed "connection error", so a rate limit looked like a server crash.
    es.addEventListener("error", (e) => {
      es.close();
      let message = null;
      try {
        message = e.data ? JSON.parse(e.data).message : null;
      } catch {
        // not JSON: treat as a lost connection
      }
      // Phase 10: a lost connection is usually this device's network (a
      // laptop just woken from sleep could not even look up the hosts for a
      // few minutes), not the server - so say which, when the browser knows.
      const lost = navigator.onLine === false
        ? "(no internet connection - reconnect and ask again)"
        : `(connection lost - check your internet connection and ask again; if it keeps happening, the server at ${API_BASE || "this site"} may be down)`;
      dispatch({ type: "ERROR", message: message ? `(${message})` : lost });
    });
  }

  async function newChat() {
    await fetch(`${API_BASE}/api/chat/session/${state.sessionId}`, { method: "DELETE", headers: codeHeaders() });
    const freshId = crypto.randomUUID();
    localStorage.setItem("sessionId", freshId);
    dispatch({ type: "RESET", sessionId: freshId });
  }

  function setMode(mode) {
    localStorage.setItem("agentMode", mode);
    dispatch({ type: "SET_MODE", mode });
  }

  function setAgent(agent) {
    dispatch({ type: "SET_AGENT", agent });
  }

  return { state, ask, newChat, setMode, setAgent, access, submitCode };
}
