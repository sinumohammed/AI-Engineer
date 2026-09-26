const SIZE = 64;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const COLORS = {
  normal: "#2563eb",
  warning: "#d97706",
  critical: "#dc2626",
};

export default function TokenRing({ usage, memory }) {
  const total = usage?.contextWindow ?? 8192;
  const used = usage?.totalTokens ?? 0;
  const fraction = Math.min(1, used / total);
  const level = usage?.warningLevel ?? "normal";
  const color = COLORS[level] ?? COLORS.normal;
  const offset = CIRCUMFERENCE * (1 - fraction);
  const percent = Math.round(fraction * 100);

  return (
    <div style={styles.outer}>
      {/* Per-message tiles already show exact "X / Y tokens (Z left)" - this
          ring is just the at-a-glance % for THIS conversation's context window.
          Hover for the exact numbers instead of duplicating them here. */}
      <div style={styles.wrap} title={usage ? `${used} / ${total} tokens used (${usage.remainingTokens} remaining)` : "No requests yet"}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="#e5e7eb" strokeWidth={STROKE} />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease" }}
          />
        </svg>
        <div style={styles.labelWrap}>
          <span style={{ ...styles.percent, color }}>{usage ? `${percent}%` : "—"}</span>
          <span style={styles.sub}>tokens</span>
        </div>
      </div>
      {memory && (
        <div
          style={styles.turnsText}
          title="How many exchanges are still fully remembered before the oldest ones get folded into a summary"
        >
          {memory.turnsRemaining}/{memory.maxTurns} turns
          {memory.hasSummary && <span title="Some earlier turns have been folded into a short summary" style={styles.summarizedDot}> 📝</span>}
        </div>
      )}
    </div>
  );
}

const styles = {
  outer: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0 },
  wrap: { position: "relative", width: SIZE, height: SIZE, flexShrink: 0 },
  labelWrap: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1.1,
  },
  percent: { fontSize: 15, fontWeight: 700 },
  sub: { fontSize: 8, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 0.5 },
  turnsText: { fontSize: 10.5, color: "#64748b", whiteSpace: "nowrap" },
  summarizedDot: { cursor: "default" },
};
