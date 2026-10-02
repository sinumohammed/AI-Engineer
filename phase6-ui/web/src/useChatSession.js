import { useEffect, useReducer, useRef } from "react";

const API_BASE = "http://localhost:3001";

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
          tools: m.tools.map((t) => (t.name === action.name && t.status === "calling" ? { ...t, status: "done" } : t)),
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

  useEffect(() => {
    fetch(`${API_BASE}/api/chat/session/${state.sessionId}`)
      .then((r) => r.json())
      .then(({ history, usage, memory }) => dispatch({ type: "LOAD", messages: historyToMessages(history, usage), usage, memory }))
      .catch(() => dispatch({ type: "LOAD", messages: [], usage: null }));
    // sessionId is stable for the lifetime of this hook instance (new instance after newChat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ask(question) {
    dispatch({ type: "ASK_START", question });

    const override = state.mode === "multi" && state.agent !== "auto" ? `&agent=${state.agent}` : "";
    const url = `${API_BASE}/api/chat/stream?sessionId=${state.sessionId}&mode=${state.mode}${override}&q=${encodeURIComponent(question)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("route", (e) => dispatch({ type: "ROUTE", ...JSON.parse(e.data) }));
    es.addEventListener("agent_start", (e) => dispatch({ type: "AGENT_START", ...JSON.parse(e.data) }));
    es.addEventListener("agent_done", (e) => dispatch({ type: "AGENT_DONE", ...JSON.parse(e.data) }));
    es.addEventListener("tool_call", (e) => dispatch({ type: "TOOL_CALL", ...JSON.parse(e.data) }));
    es.addEventListener("tool_result", (e) => dispatch({ type: "TOOL_RESULT", ...JSON.parse(e.data) }));
    es.addEventListener("answer_chunk", (e) => dispatch({ type: "ANSWER_CHUNK", ...JSON.parse(e.data) }));
    es.addEventListener("usage", (e) => dispatch({ type: "USAGE", usage: JSON.parse(e.data) }));
    es.addEventListener("memory", (e) => dispatch({ type: "MEMORY", memory: JSON.parse(e.data) }));
    es.addEventListener("done", () => {
      es.close();
      dispatch({ type: "DONE" });
    });
    es.addEventListener("error", () => {
      es.close();
      dispatch({ type: "ERROR", message: "(connection error - is the backend running on :3001?)" });
    });
  }

  async function newChat() {
    await fetch(`${API_BASE}/api/chat/session/${state.sessionId}`, { method: "DELETE" });
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

  return { state, ask, newChat, setMode, setAgent };
}
