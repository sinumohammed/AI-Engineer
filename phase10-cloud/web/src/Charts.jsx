import { useLayoutEffect, useRef, useState } from "react";

// Phase 10e: the Command Center's charts, hand-drawn SVG (no chart library).
// Colours are the validated reference palette (command.css, --s1..--s8),
// light and dark, given out in a fixed order: a caller keeps its colour
// whatever the date range, and a 9th caller folds into "Other".

export const fmtInt = (n) => Number(n ?? 0).toLocaleString();
export function fmtTokens(n) {
  const v = Number(n ?? 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return String(v);
}
export function fmtUsd(n) {
  const v = Number(n ?? 0);
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}
export function fmtMs(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${ms} ms`;
}

// Callers in a fixed order: the web chat first, then apps by name. Slots
// 1-7 are theirs; anything past that shares slot 8's grey "Other".
export function callerColors(callers) {
  const order = [...new Set(callers)].sort((a, b) => (a === "web" ? -1 : b === "web" ? 1 : a.localeCompare(b)));
  return Object.fromEntries(order.map((c, i) => [c, i < 7 ? `var(--s${i + 1})` : "var(--other)"]));
}

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function lastDays(days) {
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow * 4 >= v) * pow;
  return step * 4;
}

// Questions per day, one stacked bar per day, a segment per caller.
export function DailyChart({ rows, days, colors }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const dates = lastDays(Math.min(days, 90));
  const callers = Object.keys(colors);
  const byDay = Object.fromEntries(dates.map((d) => [d, {}]));
  for (const r of rows) if (byDay[r.day]) byDay[r.day][r.caller] = (byDay[r.day][r.caller] ?? 0) + r.questions;
  const totals = dates.map((d) => Object.values(byDay[d]).reduce((s, v) => s + v, 0));
  const max = niceMax(Math.max(0, ...totals));

  const height = 220;
  const pad = { l: 36, r: 8, t: 10, b: 26 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const slot = plotW / dates.length;
  const barW = Math.max(3, Math.min(28, slot * 0.62));
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const labelEvery = Math.ceil(dates.length / Math.max(2, Math.floor(plotW / 64)));

  return (
    <div className="chart" ref={ref}>
      {callers.length > 1 && (
        <div className="legend">
          {callers.map((c) => (
            <span key={c}>
              <i style={{ background: colors[c] }} />
              {c === "web" ? "Web chat" : c}
            </span>
          ))}
        </div>
      )}
      <svg width={width} height={height} role="img" aria-label={`Questions per day for the last ${dates.length} days`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="axis">
              {fmtInt(t)}
            </text>
          </g>
        ))}
        {dates.map((d, i) => {
          const cx = pad.l + slot * i + slot / 2;
          let acc = 0;
          const segs = callers.filter((c) => byDay[d][c]).map((c) => {
            const v = byDay[d][c];
            const seg = { c, y0: acc, y1: acc + v };
            acc += v;
            return seg;
          });
          return (
            <g key={d} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={plotH} className={hover === i ? "hit on" : "hit"} />
              {segs.map((s, k) => {
                const top = y(s.y1);
                // 2px gap between stacked segments, the top end rounded.
                const bottom = y(s.y0) - (k > 0 ? 2 : 0);
                const h = Math.max(0, bottom - top);
                const last = k === segs.length - 1;
                const r = last ? Math.min(4, h, barW / 2) : 0;
                const x0 = cx - barW / 2;
                const path = `M${x0},${bottom} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${bottom} Z`;
                return <path key={s.c} d={path} fill={colors[s.c]} />;
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 8} textAnchor="middle" className="axis">
                  {d.slice(5).replace("-", "/")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: Math.min(width - 170, Math.max(0, pad.l + slot * hover + slot / 2 - 85)) }}>
          <strong>{dates[hover]}</strong>
          <span className="tip-total">{fmtInt(totals[hover])} questions</span>
          {callers
            .filter((c) => byDay[dates[hover]][c])
            .map((c) => (
              <span key={c} className="tip-row">
                <i style={{ background: colors[c] }} />
                {c === "web" ? "Web chat" : c}
                <b>{fmtInt(byDay[dates[hover]][c])}</b>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

// One measure per row, one hue: a label, a thin bar, the value.
export function BarList({ items, format = fmtInt, color = "var(--s1)", empty = "Nothing yet" }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="barlist">
      {items.map((i) => (
        <div className="barlist-row" key={i.key} title={`${i.label}: ${format(i.value)}`}>
          <span className="barlist-label">
            {i.dot && <i style={{ background: i.dot }} />}
            {i.label}
          </span>
          <span className="barlist-track">
            <span style={{ width: `${max ? Math.max(2, (i.value / max) * 100) : 0}%`, background: i.dot ?? color }} />
          </span>
          <span className="barlist-value">{format(i.value)}</span>
        </div>
      ))}
    </div>
  );
}
