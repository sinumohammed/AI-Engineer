import { useCallback, useEffect, useState } from "react";
import { App as AntApp, Button, InputNumber, Switch, Tag, Tooltip } from "antd";
import { API_BASE } from "./useChatSession.js";
import { fmtInt } from "./Charts.jsx";

// The Command Center's controls for the connected apps that ask through
// /api/ask (masjid, kmcc...): switch an app off, and set how many questions it
// may ask a day and a month (api/appLimits.js). Only with the admin key - the
// read-only dashboard key gets a 401 here and the section says how to unlock it.
// Changes apply from the app's next question; no deployment.

function useAppLimits(adminKey) {
  const [state, setState] = useState({ data: null, denied: false, error: null });
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/app-limits`, { headers: { Authorization: `Bearer ${adminKey}` } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) return setState({ data: null, denied: true, error: null });
      if (!res.ok) throw new Error(body.error ?? `App limits could not be loaded (${res.status}).`);
      setState({ data: body, denied: false, error: null });
    } catch (err) {
      setState((s) => ({ ...s, error: err.message === "Failed to fetch" ? "The API cannot be reached." : err.message }));
    }
  }, [adminKey]);
  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 30000);
    return () => clearInterval(timer);
  }, [load]);
  return { ...state, reload: load };
}

function Used({ used, limit, label }) {
  const share = limit > 0 ? used / limit : 0;
  return (
    <div className="ft-meter">
      {limit > 0 && (
        <span className={`ft-track${share >= 0.9 ? " is-high" : ""}`}>
          <span style={{ width: `${Math.min(1, share) * 100}%` }} />
        </span>
      )}
      <span className="small">
        <b>{fmtInt(used)}</b> {limit > 0 ? `of ${fmtInt(limit)}` : "(no limit)"} {label}
      </span>
    </div>
  );
}

function AppRow({ row, adminKey, onSaved }) {
  const { message } = AntApp.useApp();
  const [daily, setDaily] = useState(row.daily);
  const [monthly, setMonthly] = useState(row.monthly);
  const [busy, setBusy] = useState(false);
  // A refresh from the server replaces what is shown, unless it is being edited.
  const changed = daily !== row.daily || monthly !== row.monthly;
  useEffect(() => {
    if (!busy) {
      setDaily(row.daily);
      setMonthly(row.monthly);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.daily, row.monthly]);

  const save = async (patch) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/app-limits/${encodeURIComponent(row.app)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Not saved (${res.status})`);
      message.success(patch.paused === true ? `${row.app} paused` : patch.paused === false ? `${row.app} is on again` : `${row.app}: limits saved`);
      onSaved();
    } catch (err) {
      message.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const usedUp = (row.daily > 0 && row.usedToday >= row.daily) || (row.monthly > 0 && row.usedMonth >= row.monthly);
  return (
    <div className="ft-row">
      <div className="ft-head">
        <span className="ft-name">{row.app}</span>
        {!row.hasKey && (
          <Tooltip title="No /api/ask key - this app cannot ask until it has one">
            <Tag>no key</Tag>
          </Tooltip>
        )}
        <span className="grow" />
        {row.paused ? <Tag color="default">Paused</Tag> : usedUp ? <Tag color="error">Used up</Tag> : <Tag color="success">On</Tag>}
        <Tooltip title={row.paused ? "Turn on: the app may ask again" : "Pause: every question from this app is refused until it is on again"}>
          <Switch size="small" checked={!row.paused} loading={busy} onChange={(on) => save({ paused: !on })} aria-label={`${row.app} on or paused`} />
        </Tooltip>
      </div>
      <Used used={row.usedToday} limit={row.daily} label="today" />
      <Used used={row.usedMonth} limit={row.monthly} label="this month" />
      <div className="app-limit-edit">
        <label>
          <span className="muted small">Per day</span>
          <InputNumber size="small" min={0} max={1000000} precision={0} value={daily} onChange={(v) => setDaily(v ?? 0)} aria-label={`${row.app}: questions per day`} />
        </label>
        <label>
          <span className="muted small">Per month</span>
          <InputNumber size="small" min={0} max={1000000} precision={0} value={monthly} onChange={(v) => setMonthly(v ?? 0)} aria-label={`${row.app}: questions per month`} />
        </label>
        <Button size="small" type="primary" disabled={!changed} loading={busy} onClick={() => save({ daily, monthly })}>
          Save
        </Button>
      </div>
    </div>
  );
}

export default function AppControls({ adminKey }) {
  const { data, denied, error, reload } = useAppLimits(adminKey);
  return (
    <section className="cc-section">
      <div className="cc-section-head">
        <h2>Connected apps · limits</h2>
        <div className="grow" />
        {data && <span className="muted small">0 = no limit · resets {data.resets}</span>}
      </div>
      {denied ? (
        <p className="muted small">Read-only: unlock the Command Center with the admin key (ADMIN_KEY) to pause apps or change their limits.</p>
      ) : error ? (
        <p className="muted small">{error}</p>
      ) : !data ? (
        <p className="muted small">Loading…</p>
      ) : !data.apps.length ? (
        <p className="muted small">No apps ask through /api/ask yet.</p>
      ) : (
        <div className="freetier">
          {data.apps.map((row) => (
            <AppRow key={row.app} row={row} adminKey={adminKey} onSaved={reload} />
          ))}
        </div>
      )}
    </section>
  );
}
