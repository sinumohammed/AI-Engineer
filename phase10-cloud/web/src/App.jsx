import { useState, useEffect, useRef } from "react";
import { useChatSession } from "./useChatSession.js";
import TokenRing from "./TokenRing.jsx";

export default function App() {
  const { state, ask, newChat, setMode, setAgent } = useChatSession();
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  // Refocus the input once the response finishes (busy goes false -> the
  // input's `disabled` attribute is what steals focus while streaming, since
  // a disabled element can't hold it).
  useEffect(() => {
    if (!state.busy) inputRef.current?.focus();
  }, [state.busy]);

  function handleSubmit(e) {
    e.preventDefault();
    if (!input.trim() || state.busy) return;
    ask(input.trim());
    setInput("");
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <TokenRing usage={state.usage} memory={state.memory} />
          <div style={styles.headerText}>
            <h1 style={styles.title}>Agent Chat</h1>
            <p style={styles.subtitle}>Company docs + general knowledge, remembered across refreshes.</p>
          </div>
          {/* Phase 8c: which backend answers the next question. Switching
              keeps the conversation - both modes share the same session. */}
          <div style={styles.modeToggle} title="Single agent: one model call. Multi-agent: a router picks a specialist.">
            {[
              ["single", "Single agent"],
              ["multi", "Multi-agent"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                style={styles.modeButton(state.mode === value)}
                onClick={() => setMode(value)}
                disabled={state.busy}
              >
                {label}
              </button>
            ))}
          </div>
          <button style={styles.newChatButton} onClick={newChat} disabled={state.busy}>
            + New chat
          </button>
        </div>

        <div style={styles.chatBox}>
          {!state.loaded && <div style={styles.loadingHint}>Loading conversation…</div>}
          {state.loaded && state.messages.length === 0 && (
            <div style={styles.emptyHint}>Ask about our rollback process, on-call rotation, or anything general.</div>
          )}
          {state.messages.map((m, i) => (
            <div key={i} style={styles.row(m.role)}>
              <div style={styles.avatar(m.role)}>{m.role === "user" ? "U" : "A"}</div>
              <div style={styles.bubble(m.role)}>
                {m.role === "assistant" && m.tools?.length > 0 && (
                  <div style={styles.toolLog}>
                    {/* Phase 9: the document search runs on every question, so
                        the chip also says what it led to. "not relevant" is
                        grey: the search ran, but the answer came from the
                        model's own knowledge. */}
                    {m.tools.map((t, j) => (
                      <span key={j} style={styles.toolChip(t.outcome === "used" || !t.outcome ? t.status : "skipped")}>
                        {t.status === "calling" ? "⏳" : "✓"} {t.name}
                        {t.outcome && ` · ${t.outcome}`}
                      </span>
                    ))}
                  </div>
                )}
                {/* Phase 8c: the supervisor's hand-off - one chip per
                    specialist (hover for the task it was given), then the
                    router's own reason for sending the question there. */}
                {m.role === "assistant" && m.agents?.length > 0 && (
                  <div style={styles.routeBox}>
                    <div style={styles.toolLog}>
                      <span style={styles.routeLabel}>{m.route?.manual ? "manual pick" : "routed to"}</span>
                      {m.agents.map((a) => (
                        <span key={a.index} style={styles.toolChip(a.status === "running" ? "calling" : "done")} title={a.question}>
                          {a.status === "running" ? "⏳" : "✓"} {a.agent}
                          {a.latencyMs != null && ` · ${(a.latencyMs / 1000).toFixed(1)}s`}
                        </span>
                      ))}
                    </div>
                    {m.route?.reason && <div style={styles.routeReason}>{m.route.reason}</div>}
                  </div>
                )}
                <div style={styles.bubbleText}>
                  {m.text || (m.role === "assistant" ? <TypingDots /> : "")}
                </div>
                {/* Phase 9.6: the document sections this answer cited, by the
                    same numbers that appear in the text, e.g. [1]. */}
                {m.role === "assistant" && m.sources?.length > 0 && (
                  <div style={styles.sources}>
                    <span style={styles.sourcesLabel}>Sources</span>
                    {m.sources.map((src) => (
                      <div key={`${src.n}-${src.source}`} style={styles.sourceRow} title={src.source}>
                        <span style={styles.sourceNumber}>[{src.n}]</span> {src.section}
                        <span style={styles.sourceFile}> · {src.source}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Phase 10: e.g. "Answered by openai/gpt-oss-20b: today's
                    free limit for openai/gpt-oss-120b is used up." */}
                {m.role === "assistant" && m.notices?.map((text) => (
                  <div key={text} style={styles.notice}>{text}</div>
                ))}
                {m.role === "assistant" && m.usage && (
                  <UsageFooter usage={m.usage} />
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          {/* Manual override (multi-agent mode only): "Auto" lets the router
              pick; choosing a specialist skips the router for the next
              questions. Highlighted while active so it is not forgotten. */}
          {state.mode === "multi" && (
            <select
              style={styles.agentSelect(state.agent !== "auto")}
              value={state.agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={state.busy}
              title="Who answers: Auto lets the router decide, or pick a specialist yourself"
            >
              <option value="auto">Auto</option>
              <option value="company_docs">Company docs</option>
              <option value="coding">Coding</option>
              <option value="general">General</option>
            </select>
          )}
          <input
            ref={inputRef}
            style={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question…"
            disabled={state.busy}
            autoFocus
          />
          <button style={styles.button(state.busy || !input.trim())} disabled={state.busy || !input.trim()}>
            {state.busy ? <Spinner /> : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span style={styles.typing}>
      <span style={styles.dot(0)} />
      <span style={styles.dot(0.15)} />
      <span style={styles.dot(0.3)} />
    </span>
  );
}

function Spinner() {
  return <span style={styles.spinner} />;
}

function UsageFooter({ usage }) {
  const pct = Math.min(100, (usage.totalTokens / usage.contextWindow) * 100);
  const color = usage.warningLevel === "critical" ? "#dc2626" : usage.warningLevel === "warning" ? "#d97706" : "#2563eb";
  return (
    <div style={styles.usageFooter}>
      <div style={styles.usageBarWrap}>
        <div style={styles.usageTrack}>
          <div style={{ ...styles.usageFill, width: `${pct}%`, background: color }} />
        </div>
        <span style={styles.usageText}>
          {usage.totalTokens} / {usage.contextWindow} tokens ({usage.remainingTokens} left)
          {/* Multi-agent mode only: the bar shows the largest single call;
              this is what the whole question cost across all calls. */}
          {usage.llmCalls != null && ` · ${usage.llmCalls} model calls, ${usage.allCallsTokens} tokens in total`}
        </span>
      </div>
      {usage.warningLevel && (
        <div style={usage.warningLevel === "critical" ? styles.warningCritical : styles.warningNormal}>
          ⚠️ {usage.warningMessage}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)",
    display: "flex",
    justifyContent: "center",
    padding: "32px 16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: 760,
    background: "white",
    borderRadius: 20,
    boxShadow: "0 10px 40px rgba(15, 23, 42, 0.08)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    height: "calc(100vh - 64px)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "20px 24px",
    borderBottom: "1px solid #f1f5f9",
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { margin: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" },
  subtitle: { margin: "2px 0 0", fontSize: 12.5, color: "#64748b" },
  newChatButton: {
    padding: "8px 14px",
    borderRadius: 10,
    border: "1px solid #e2e8f0",
    background: "#f8fafc",
    fontSize: 13,
    fontWeight: 600,
    color: "#334155",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  chatBox: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  loadingHint: { color: "#94a3b8", fontSize: 13, textAlign: "center", marginTop: 40 },
  emptyHint: { color: "#94a3b8", fontSize: 13.5, textAlign: "center", marginTop: 40, lineHeight: 1.6 },
  row: (role) => ({
    display: "flex",
    flexDirection: role === "user" ? "row-reverse" : "row",
    gap: 10,
    alignItems: "flex-start",
  }),
  avatar: (role) => ({
    width: 28,
    height: 28,
    borderRadius: "50%",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 700,
    color: "white",
    background: role === "user" ? "#2563eb" : "#7c3aed",
  }),
  bubble: (role) => ({
    maxWidth: "78%",
    background: role === "user" ? "#2563eb" : "#f1f5f9",
    color: role === "user" ? "white" : "#0f172a",
    padding: "10px 14px",
    borderRadius: 14,
    borderTopRightRadius: role === "user" ? 4 : 14,
    borderTopLeftRadius: role === "user" ? 14 : 4,
  }),
  bubbleText: { fontSize: 14.5, lineHeight: 1.5, whiteSpace: "pre-wrap" },
  toolLog: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  toolChip: (status) => ({
    fontSize: 11,
    fontFamily: "monospace",
    padding: "3px 8px",
    borderRadius: 999,
    background: status === "calling" ? "#fef3c7" : status === "skipped" ? "#e2e8f0" : "#dcfce7",
    color: status === "calling" ? "#92400e" : status === "skipped" ? "#475569" : "#166534",
  }),
  modeToggle: {
    display: "flex",
    padding: 3,
    borderRadius: 10,
    background: "#f1f5f9",
    flexShrink: 0,
  },
  modeButton: (active) => ({
    padding: "6px 10px",
    borderRadius: 8,
    border: "none",
    background: active ? "white" : "transparent",
    boxShadow: active ? "0 1px 3px rgba(15, 23, 42, 0.12)" : "none",
    fontSize: 12,
    fontWeight: 600,
    color: active ? "#0f172a" : "#64748b",
    cursor: "pointer",
    whiteSpace: "nowrap",
  }),
  agentSelect: (overriding) => ({
    padding: "0 10px",
    borderRadius: 12,
    border: `1px solid ${overriding ? "#f59e0b" : "#e2e8f0"}`,
    background: overriding ? "#fef3c7" : "white",
    color: overriding ? "#92400e" : "#334155",
    fontSize: 13,
    fontWeight: 600,
    outline: "none",
    cursor: "pointer",
  }),
  sources: { marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: 3 },
  notice: { marginTop: 8, padding: "5px 8px", borderRadius: 6, background: "#fef3c7", color: "#92400e", fontSize: 11.5 },
  sourcesLabel: { fontSize: 10.5, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" },
  sourceRow: { fontSize: 12, color: "#334155", lineHeight: 1.4, overflowWrap: "anywhere" },
  sourceNumber: { fontFamily: "monospace", color: "#2563eb", fontWeight: 600 },
  sourceFile: { color: "#94a3b8", fontSize: 11 },
  routeBox: { marginBottom: 8 },
  routeLabel: { fontSize: 11, color: "#64748b", alignSelf: "center" },
  routeReason: { fontSize: 11.5, color: "#64748b", fontStyle: "italic", lineHeight: 1.45 },
  usageFooter: { marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(0,0,0,0.06)" },
  usageBarWrap: { display: "flex", alignItems: "center", gap: 8 },
  usageTrack: { width: 90, height: 5, borderRadius: 3, background: "rgba(0,0,0,0.1)", overflow: "hidden", flexShrink: 0 },
  usageFill: { height: "100%", transition: "width 0.3s ease, background 0.3s ease" },
  usageText: { fontSize: 10.5, color: "#64748b" },
  warningNormal: {
    marginTop: 6,
    fontSize: 11,
    color: "#92400e",
    background: "#fef3c7",
    padding: "5px 9px",
    borderRadius: 8,
  },
  warningCritical: {
    marginTop: 6,
    fontSize: 11,
    color: "#991b1b",
    background: "#fee2e2",
    padding: "5px 9px",
    borderRadius: 8,
  },
  form: {
    display: "flex",
    gap: 10,
    padding: "16px 24px",
    borderTop: "1px solid #f1f5f9",
    background: "#fafbfc",
  },
  input: {
    flex: 1,
    padding: "11px 14px",
    borderRadius: 12,
    border: "1px solid #e2e8f0",
    fontSize: 14,
    outline: "none",
  },
  button: (disabled) => ({
    padding: "0 20px",
    borderRadius: 12,
    border: "none",
    background: disabled ? "#c7d2fe" : "#2563eb",
    color: "white",
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    minWidth: 72,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  }),
  typing: { display: "inline-flex", gap: 3, alignItems: "center", height: 16 },
  dot: (delay) => ({
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#94a3b8",
    animation: "aiengineer-blink 1.2s infinite",
    animationDelay: `${delay}s`,
  }),
  spinner: {
    width: 14,
    height: 14,
    border: "2px solid rgba(255,255,255,0.5)",
    borderTopColor: "white",
    borderRadius: "50%",
    display: "inline-block",
    animation: "aiengineer-spin 0.7s linear infinite",
  },
};
