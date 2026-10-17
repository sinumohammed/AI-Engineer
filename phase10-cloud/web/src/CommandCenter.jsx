import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Card, Drawer, Grid, Input, Segmented, Select, Switch, Table, Tag, Tooltip, Typography, theme } from "antd";
import XMarkdown from "@ant-design/x-markdown";
import {
  ArrowLeftOutlined,
  AudioOutlined,
  CheckCircleFilled,
  ClearOutlined,
  CloseCircleFilled,
  LockOutlined,
  ReloadOutlined,
  SendOutlined,
  SoundOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { API_BASE } from "./useChatSession.js";
import { AGENT_LABELS, VOICE_LANGUAGES } from "./Sidebar.jsx";
import { API_BASE as API, codeHeaders } from "./useChatSession.js";
import { useVoiceInput, voiceSupported, unlockAudio } from "./useVoiceInput.js";
import { useBargeIn } from "./useBargeIn.js";
import { useClapWake } from "./useClapWake.js";
import { useCommand } from "./useCommand.js";
import { BarList, DailyChart, callerColors, callerLabel, fmtInt, fmtMs, fmtTokens, fmtUsd } from "./Charts.jsx";
import { dayLabel, fullTime, shortTime } from "./time.js";
import "./command.css";

const { Text } = Typography;

// Phase 10e: the Command Center - one screen to run and watch the AI
// service. Two halves:
//   1. a console: ask by typing, by voice, or hands-free (clap twice), and
//      watch the router hand the question to the specialists, live; the
//      answer can be read out loud.
//   2. usage and cost per app - who uses the service, how much, which agents
//      and models, what failed (GET /api/admin/usage, api/usage.js).
// Opened at #/command. Needs the dashboard key (DASHBOARD_KEY or ADMIN_KEY on
// the server) and, on the hosted API, the access code.

const SPECIALISTS = ["company_docs", "coding", "general", "attachment", "connected_apps"];
// Each specialist keeps one palette slot, here and in the usage charts.
export const AGENT_COLORS = {
  company_docs: "var(--s1)",
  coding: "var(--s2)",
  general: "var(--s3)",
  attachment: "var(--s4)",
  connected_apps: "var(--s5)",
  single_agent: "var(--s7)",
  synthesizer: "var(--other)",
};
const RANGES = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

function stored(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function store(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage blocked: kept for this page only
  }
}

// --- reading answers out loud ---

// Markdown, citations and code read badly; the screen shows them anyway.
function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, " The code is on the screen. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s*\[\d+\]/g, "")
    .replace(/[*_#>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
// Phones (iPhone Safari, some Android browsers) only read aloud if the first
// speak() happens inside a tap; the answer arrives seconds later, so it was
// silently blocked (found on a phone). Every tap that can lead to an answer
// says an empty, silent phrase first, which unlocks speech for the page.
// The same goes for playing audio: one player, started inside a tap with a
// moment of silence, can then play the server's voice later.
const player = typeof Audio !== "undefined" ? new Audio() : null;
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
let speechUnlocked = false;
function unlockSpeech() {
  unlockAudio(); // also for listening that starts by itself (conversation mode)
  if (speechUnlocked) return;
  speechUnlocked = true;
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }
  if (player) {
    player.src = SILENCE;
    player.play().catch(() => {});
  }
}

// Sentence by sentence, in pieces of up to `max` characters: some browsers
// stop one long utterance after about 15 seconds, and the server voice
// starts sooner on a short piece.
function pieces(text, max) {
  const out = [];
  for (const sentence of speakable(text).slice(0, 1500).match(/[^.!?।]+[.!?।]*\s*/g) ?? []) {
    if (out.length && (out.at(-1) + sentence).length <= max) out[out.length - 1] += sentence;
    else out.push(sentence);
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

// Which voice reads it, cheapest first:
//   1. text in Latin letters (English and most European languages): the
//      device's own voice - free, nothing leaves the device;
//   2. another script with a device voice for that language (Arabic on most
//      phones, Hindi on many): that device voice - no daily limit;
//   3. otherwise (Malayalam on most devices - they read "dot dot"): Gemini's
//      voice on the server. Its free tier allows 10 requests a day (found
//      live 2026-10-17 through the "what failed" list), so an answer is at
//      most 2 requests: a short first part, to start reading soon, and the
//      rest in one.
function needsServerVoice(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = text.match(/\p{Script=Latin}/gu) ?? [];
  return letters.length > 0 && latin.length / letters.length < 0.6;
}

// The script an answer is written in -> the language codes a device voice
// for it would have.
const SCRIPT_LANGS = [
  ["Malayalam", ["ml"]],
  ["Arabic", ["ar", "ur"]],
  ["Devanagari", ["hi", "mr"]],
  ["Tamil", ["ta"]],
  ["Kannada", ["kn"]],
  ["Telugu", ["te"]],
  ["Bengali", ["bn"]],
  ["Gujarati", ["gu"]],
  ["Gurmukhi", ["pa"]],
];
function languagesOf(text) {
  let best = [[], 0];
  for (const [script, langs] of SCRIPT_LANGS) {
    const n = (text.match(new RegExp(`\\p{Script=${script}}`, "gu")) ?? []).length;
    if (n > best[1]) best = [langs, n];
  }
  return best[0];
}
// A device voice for one of these languages, if the device has one. The list
// can be empty until the browser has loaded it ("voiceschanged").
async function deviceVoiceFor(langs) {
  const synth = window.speechSynthesis;
  if (!synth || !langs.length) return null;
  let voices = synth.getVoices();
  if (!voices.length) {
    await new Promise((resolve) => {
      synth.addEventListener?.("voiceschanged", resolve, { once: true });
      setTimeout(resolve, 500);
    });
    voices = synth.getVoices();
  }
  return voices.find((v) => langs.some((l) => (v.lang ?? "").toLowerCase().replace("_", "-").startsWith(l))) ?? null;
}

let speechRun = 0; // a newer read-out (or Stop) ends an older one
let finishPiece = null; // ends the piece being read when it is stopped
function stopAllSpeech() {
  speechRun++;
  finishPiece?.();
  finishPiece = null;
  window.speechSynthesis?.cancel();
  if (player) {
    player.pause();
    player.removeAttribute("src");
  }
}

function deviceSpeak(text, voice) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  const parts = pieces(text, 220);
  return new Promise((resolve) => {
    finishPiece = resolve;
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.rate = 1.03;
      if (voice) {
        u.lang = voice.lang;
        try {
          u.voice = voice;
        } catch {
          // not a voice this browser accepts: the language alone picks one
        }
      }
      if (i === parts.length - 1) u.onend = u.onerror = resolve;
      window.speechSynthesis.speak(u);
    });
    if (!parts.length) resolve();
  });
}

// At most two server requests: up to ~300 characters first, the rest together.
function serverParts(text) {
  const all = pieces(text, 300);
  if (all.length <= 1) return all;
  const rest = all.slice(1).join(" ");
  return [all[0], rest.length > 1500 ? rest.slice(0, rest.lastIndexOf(" ", 1500)) : rest];
}

// Reads `text` aloud; resolves when done. Throws with a reason the user can
// read when the server voice is refused or its daily limit is used up.
async function speak(text, { sources = [] } = {}) {
  stopAllSpeech();
  const run = speechRun;
  if (!needsServerVoice(text)) return deviceSpeak(text, null);
  const voice = await deviceVoiceFor(languagesOf(text));
  if (run !== speechRun) return;
  if (voice) return deviceSpeak(text, voice);
  // Server voice: fetch the second part while the first plays.
  const parts = serverParts(text);
  const fetchPiece = (p) =>
    fetch(`${API}/api/speak`, { method: "POST", headers: { "Content-Type": "application/json", ...codeHeaders() }, body: JSON.stringify({ text: p, sources: sources.map((s) => s.source) }) }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not read it aloud (${r.status}).`);
      return URL.createObjectURL(await r.blob());
    });
  let next = parts.length ? fetchPiece(parts[0]) : null;
  for (let i = 0; i < parts.length; i++) {
    const url = await next;
    next = i + 1 < parts.length ? fetchPiece(parts[i + 1]) : null;
    next?.catch(() => {}); // a failure is reported when its turn comes
    if (run !== speechRun || !player) return URL.revokeObjectURL(url);
    await new Promise((resolve) => {
      finishPiece = resolve;
      player.onended = player.onerror = resolve;
      player.src = url;
      player.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
    if (run !== speechRun) return;
  }
}

// A short rising two-note chime: "I'm listening".
function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [660, 990].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.18);
    });
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {
    // no Web Audio: no chime
  }
}

// --- data ---

function useUsage(dashKey, days, onUnauthorized) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!dashKey) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/usage?days=${days}`, { headers: { Authorization: `Bearer ${dashKey}` } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 404) {
        onUnauthorized(body.error ?? "That key was not accepted.");
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `Usage could not be loaded (${res.status}).`);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err.message === "Failed to fetch" ? "The API cannot be reached." : err.message);
    } finally {
      setLoading(false);
    }
  }, [dashKey, days, onUnauthorized]);

  useEffect(() => {
    load();
    // Every 30 seconds while the page is visible.
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 30000);
    return () => clearInterval(timer);
  }, [load]);
  return { data, error, loading, reload: load };
}

// --- the page ---

export default function CommandCenter({ isDark }) {
  const { token } = theme.useToken();
  const [dashKey, setDashKey] = useState(() => stored("dashboardKey"));
  const [accessCode, setAccessCode] = useState(() => stored("accessCode"));
  const [access, setAccess] = useState({ checked: false, needed: false, voice: false });
  const [lockReason, setLockReason] = useState(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    fetch(`${API_BASE}/api/access`, { headers: accessCode ? { "x-access-code": accessCode } : {} })
      .then((r) => r.json())
      .then((a) => setAccess({ checked: true, needed: a.required && !a.ok, voice: Boolean(a.voice) }))
      .catch(() => setAccess({ checked: true, needed: false, voice: false }));
  }, [accessCode]);

  const lock = useCallback((reason) => {
    store("dashboardKey", "");
    setDashKey("");
    setLockReason(reason);
  }, []);
  const usage = useUsage(dashKey, days, lock);

  const cssVars = {
    "--bg": token.colorBgLayout,
    "--panel": token.colorBgContainer,
    "--border": token.colorBorderSecondary,
    "--text": token.colorText,
    "--muted": token.colorTextSecondary,
    "--primary": token.colorPrimary,
    "--primary-soft": token.colorPrimaryBg,
  };
  const root = `cc ${isDark ? "cc-dark" : "cc-light"}`;

  if (!access.checked) return <div className={root} style={cssVars} />;
  if (!dashKey || access.needed) {
    return (
      <div className={root} style={cssVars}>
        <Unlock
          needsKey={!dashKey}
          needsCode={access.needed}
          reason={lockReason ?? (access.needed && accessCode ? "That access code was not accepted." : null)}
          onSubmit={({ key, code }) => {
            if (key) {
              store("dashboardKey", key);
              setDashKey(key);
            }
            if (code) {
              store("accessCode", code);
              setAccessCode(code);
            }
            setLockReason(null);
          }}
        />
      </div>
    );
  }

  const d = usage.data;
  return (
    <div className={root} style={cssVars}>
      <header className="cc-top">
        <Button type="text" icon={<ArrowLeftOutlined />} href="#/" aria-label="Back to the chat" />
        <div className="cc-title">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <div>
            <h1>Command Center</h1>
            <span className="muted small">AI service · agents, apps and usage</span>
          </div>
        </div>
        <div className="grow" />
        <StatusPill data={d} error={usage.error} loading={usage.loading} />
        <Tooltip title="Lock - forget the dashboard key in this browser">
          <Button type="text" icon={<LockOutlined />} onClick={() => lock(null)} aria-label="Lock" />
        </Tooltip>
      </header>

      <main className="cc-main">
        <Console accessCode={accessCode} dashKey={dashKey} voiceOnServer={access.voice} onAnswered={usage.reload} />

        <section className="cc-section">
          <div className="cc-section-head">
            <h2>Usage and cost</h2>
            <div className="grow" />
            <Segmented size="small" options={RANGES} value={days} onChange={setDays} />
            <Tooltip title="Refresh now (it also refreshes every 30 seconds)">
              <Button size="small" type="text" icon={<ReloadOutlined spin={usage.loading} />} onClick={usage.reload} aria-label="Refresh" />
            </Tooltip>
          </div>
          {usage.error && <Alert type="warning" showIcon title={usage.error} className="slim" />}
          {d ? <UsagePanels d={d} /> : !usage.error && <p className="muted">Loading usage…</p>}
        </section>
      </main>
    </div>
  );
}

function StatusPill({ data, error, loading }) {
  if (error) return <Tag color="error">API unreachable</Tag>;
  if (!data) return <Tag>{loading ? "Connecting…" : "—"}</Tag>;
  return (
    <Tooltip title={`Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}>
      <Tag color="success" className="pill">
        <span className="dot-live" /> Online
      </Tag>
    </Tooltip>
  );
}

function Unlock({ needsKey, needsCode, reason, onSubmit }) {
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  return (
    <div className="cc-unlock">
      <Card>
        <div className="cc-title">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <div>
            <h1>Command Center</h1>
            <span className="muted small">Usage, cost and the agents at work</span>
          </div>
        </div>
        <Text type="secondary">
          {needsKey ? "Enter the dashboard key (DASHBOARD_KEY on the server). It is kept in this browser only." : "Enter the access code for the AI service."}
        </Text>
        {reason && <Alert type="error" showIcon title={reason} className="slim" />}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if ((!needsKey || key.trim()) && (!needsCode || code.trim())) onSubmit({ key: key.trim(), code: code.trim() });
          }}
        >
          {needsKey && <Input.Password size="large" placeholder="Dashboard key" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />}
          {needsCode && <Input.Password size="large" placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus={!needsKey} />}
          <Button type="primary" size="large" htmlType="submit" block>
            Open
          </Button>
        </form>
        <Button type="link" href="#/" icon={<ArrowLeftOutlined />}>
          Back to the chat
        </Button>
      </Card>
    </div>
  );
}

// --- the console: ask, watch the agents, hear the answer ---

function Console({ accessCode, dashKey, voiceOnServer, onAnswered }) {
  const { message } = AntApp.useApp();
  const [input, setInput] = useState("");
  // Clap to wake holds the microphone open, so it is never switched on by
  // itself: off on every visit, and off when the page is hidden.
  const [clapOn, setClapOn] = useState(false);
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && setClapOn(false);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  const [speakOn, setSpeakOn] = useState(() => stored("speakAnswers") !== "0");
  const speakRef = useRef(speakOn);
  speakRef.current = speakOn;
  const [speaking, setSpeaking] = useState(false);
  // The language the user speaks: a hint for speech to text, shared with the chat.
  const [voiceLanguage, setVoiceLanguage] = useState(() => stored("voiceLanguage") || "auto");

  // Conversation mode: started by two claps or the mic, it listens again by
  // itself after each answer (no clap or tap), can be interrupted by talking
  // over the answer, and ends after ~8 s of silence, on "stop" / "bye" /
  // "മതി", or with the End button. A ref too: the callbacks run later.
  const [conversation, setConversation] = useState(false);
  const convRef = useRef(false);
  function startConversation() {
    convRef.current = true;
    setConversation(true);
  }
  function endConversation(note) {
    if (!convRef.current) return;
    convRef.current = false;
    setConversation(false);
    if (note) message.info(note);
  }

  const { run, ask, cancel, forget } = useCommand({
    accessCode,
    dashKey,
    onDone: (r) => {
      onAnswered();
      if (speakRef.current && r.answer) readOut(r);
      else if (convRef.current) nextTurn();
    },
  });
  const busy = ["routing", "working", "answering"].includes(run.phase);

  const canSpeak = voiceOnServer && voiceSupported();
  const voice = useVoiceInput({
    silenceMs: 1400,
    onText: (text) => {
      setInput("");
      // "stop", "bye", "that's all", "മതി" (enough): the user is done.
      if (convRef.current && /^\s*(stop|bye|goodbye|that'?s all|that is all|no thanks|nothing|end( (the )?conversation)?|മതി|നിർത്തൂ|നിർത്ത്)\s*[.!]?\s*$/i.test(text)) {
        return endConversation("Conversation ended");
      }
      ask(text);
    },
    onError: (msg) => {
      // In a conversation, silence after an answer is the user being done.
      if (convRef.current) return endConversation(/didn.t (hear|catch)/i.test(msg) ? "Conversation ended - nothing more said" : msg);
      message.warning(msg);
    },
    language: voiceLanguage,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  function readOut(r) {
    setSpeaking(true);
    speak(r.answer, { sources: r.sources })
      .catch((err) => message.warning(err.message))
      .finally(() => {
        setSpeaking(false);
        // Finished, stopped by a tap, or interrupted by talking: your turn.
        if (convRef.current) nextTurn();
      });
  }
  // The next turn of a conversation: a chime, then listen.
  function nextTurn() {
    setTimeout(() => {
      if (!convRef.current || voiceRef.current.active()) return;
      chime();
      setTimeout(() => convRef.current && voiceRef.current.start(), 300);
    }, 150);
  }
  function stopSpeaking() {
    stopAllSpeech();
    setSpeaking(false);
  }
  // From a tap: start recording inside the tap itself - a phone only lets
  // audio run when it starts from the user's touch (found on a phone: started
  // a moment later, the recording heard nothing and never stopped).
  function listen() {
    if (voice.status !== "idle" || busy) return;
    stopSpeaking();
    unlockSpeech();
    startConversation();
    voice.start();
  }
  // From two claps: a chime first, then record.
  const wake = useCallback(() => {
    if (voice.status !== "idle" || busy) return;
    stopSpeaking();
    startConversation();
    chime();
    setTimeout(() => voice.start(), 300);
  }, [voice, busy]);
  // The clap listener holds the mic only while nothing else is going on: it
  // lets go while a question is recorded, answered or read out.
  const idleNow = voice.status === "idle" && !busy && !speaking;
  const clap = useClapWake({ enabled: clapOn && canSpeak && idleNow && !conversation, paused: false, onWake: wake });
  // Talking over the answer stops it; readOut's finally then listens.
  const [bargeIn, setBargeIn] = useState(() => stored("bargeIn") !== "0");
  useBargeIn({ enabled: conversation && speaking && bargeIn && canSpeak, onSpeech: () => stopAllSpeech() });
  // Leaving the page ends a conversation, as it ends clap to wake.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && endConversation(null);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!clap.lastClap) return undefined;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 220);
    return () => clearTimeout(t);
  }, [clap.lastClap]);

  function send() {
    const q = input.trim();
    if (!q || busy) return;
    stopSpeaking();
    if (speakOn) unlockSpeech();
    setInput("");
    ask(q);
  }

  const orbState =
    voice.status === "recording" ? "listening" : voice.status === "transcribing" ? "hearing" : busy ? "thinking" : speaking ? "speaking" : clap.status === "listening" ? "standby" : clap.status === "needs-tap" ? "blocked" : "idle";
  const orbText = {
    listening: conversation && run.phase !== "idle" ? "Your turn - speak, or stay quiet to end" : "Listening… pause when you are done",
    hearing: "Turning speech into text…",
    thinking: run.phase === "routing" ? "Routing the question…" : "Agents at work…",
    speaking: conversation && bargeIn ? "Speaking… talk or tap to interrupt" : "Speaking… tap to stop",
    standby: "Clap twice to wake me",
    blocked: "Tap anywhere to start listening for claps",
    idle: canSpeak ? "Type, tap the mic, or turn on clap to wake" : "Type a command",
  }[orbState];
  const level = voice.status === "recording" ? Math.max(...voice.levels.slice(-4)) : 0;

  return (
    <section className="cc-console">
      <div className="cc-console-left">
        <div
          className={`orb orb-${orbState}${flash ? " orb-flash" : ""}`}
          style={{ "--level": level }}
          role={orbState === "listening" || orbState === "speaking" ? "button" : undefined}
          aria-label={orbState === "listening" ? "Stop and send" : orbState === "speaking" ? "Stop reading out" : undefined}
          onClick={() => (orbState === "listening" ? voice.stop() : orbState === "speaking" ? stopAllSpeech() : null)}
        >
          <div className="orb-ring" />
          <div className="orb-ring r2" />
          <div className="orb-core">
            {orbState === "listening" ? <AudioOutlined /> : orbState === "speaking" ? <SoundOutlined /> : <span className="orb-glyph">AI</span>}
          </div>
        </div>
        <div className="orb-text" aria-live="polite">
          {orbText}
        </div>
        {voice.status === "recording" && (
          <Button type="primary" danger shape="round" icon={<StopOutlined />} onClick={voice.stop}>
            Stop and send
          </Button>
        )}
        {speaking && (
          <Button shape="round" icon={<StopOutlined />} onClick={() => stopAllSpeech()}>
            {conversation ? "Interrupt" : "Stop reading"}
          </Button>
        )}
        {conversation && (
          <div className="conv-on" role="status">
            <span className="dot-live" /> Conversation on
            <Button
              size="small"
              type="link"
              onClick={() => {
                endConversation(null);
                stopSpeaking();
                if (voice.status === "recording") voice.cancel();
              }}
            >
              End
            </Button>
          </div>
        )}
        {clapOn && canSpeak && (
          <div className="mic-on" role="status">
            <span className="dot-live" /> Mic on - listening for claps
            <Button size="small" type="link" onClick={() => setClapOn(false)}>
              Turn off
            </Button>
          </div>
        )}

        <div className="cc-controls">
          <Tooltip title={canSpeak ? "Listen for two claps. The microphone stays in this browser until you clap." : "Voice is off on this server or browser"}>
            <label className="ctl">
              <Switch
                size="small"
                checked={clapOn && canSpeak}
                disabled={!canSpeak}
                onChange={(v) => {
                  if (v && speakOn) unlockSpeech(); // answers after a clap have no tap of their own
                  setClapOn(v);
                }}
              />
              Clap to wake
            </label>
          </Tooltip>
          <label className="ctl">
            <Switch
              size="small"
              checked={speakOn}
              onChange={(v) => {
                setSpeakOn(v);
                store("speakAnswers", v ? "1" : "0");
                if (v) unlockSpeech();
                if (!v) stopSpeaking();
              }}
            />
            Speak answers
          </label>
          {canSpeak && (
            <Tooltip title="In a conversation, start talking while it speaks to interrupt it. Best with headphones; off: tap the orb to interrupt.">
              <label className="ctl">
                <Switch
                  size="small"
                  checked={bargeIn}
                  onChange={(v) => {
                    setBargeIn(v);
                    store("bargeIn", v ? "1" : "0");
                  }}
                />
                Talk to interrupt
              </label>
            </Tooltip>
          )}
        </div>
        {canSpeak && (
          <Select
            size="small"
            className="cc-lang"
            value={voiceLanguage}
            options={VOICE_LANGUAGES}
            onChange={(v) => {
              setVoiceLanguage(v);
              store("voiceLanguage", v);
            }}
            aria-label="The language you speak"
          />
        )}
        {clap.error && <Alert type="warning" showIcon title={clap.error} className="slim" />}

        <div className="cc-ask">
          <Input
            size="large"
            placeholder="Ask the agents anything…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={send}
            disabled={voice.status !== "idle"}
          />
          {canSpeak && (
            <Button
                size="large"
                shape="circle"
                type={voice.status === "recording" ? "primary" : "default"}
                danger={voice.status === "recording"}
                icon={voice.status === "recording" ? <StopOutlined /> : <AudioOutlined />}
                loading={voice.status === "transcribing"}
                onClick={() => (voice.status === "recording" ? voice.stop() : listen())}
                disabled={busy}
                aria-label={voice.status === "recording" ? "Stop and send" : "Voice command"}
              />
          )}
          {busy ? (
            <Button size="large" shape="circle" icon={<StopOutlined />} onClick={cancel} aria-label="Stop" />
          ) : (
            <Button size="large" shape="circle" type="primary" icon={<SendOutlined />} onClick={send} disabled={!input.trim()} aria-label="Send" />
          )}
        </div>
      </div>

      <div className="cc-console-right">
        <div className="cc-panel-head">
          <h2>Agents</h2>
          <span className="muted small">{run.phase === "idle" ? "Waiting for a command" : run.question}</span>
          <div className="grow" />
          {run.phase !== "idle" && (
            <Tooltip title="New conversation - forget earlier commands">
              <Button size="small" type="text" icon={<ClearOutlined />} onClick={forget} disabled={busy} aria-label="New conversation" />
            </Tooltip>
          )}
        </div>
        <AgentMap run={run} />
        <CommsLog run={run} />
        {(run.answer || run.error) && (
          <div className="cc-answer">
            {run.answer && <XMarkdown content={run.answer} className="answer" streaming={{ hasNextChunk: run.phase === "answering" }} openLinksInNewTab />}
            {run.error && <Alert type="warning" showIcon title={run.error} className="slim" />}
            {run.phase === "done" && (
              <div className="muted small cc-answer-foot">
                {fmtMs(run.finishedAt - run.startedAt)}
                {run.usage && ` · ${run.usage.llmCalls ?? 1} model calls · ${fmtTokens((run.usage.promptTokens ?? 0) + (run.usage.completionTokens ?? 0))} tokens`}
                {run.answer && (
                  <Button
                    size="small"
                    type="link"
                    icon={<SoundOutlined />}
                    onClick={() => {
                      unlockSpeech();
                      readOut(run);
                    }}
                  >
                    Read out
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// The question's path: You -> Router -> specialists -> Combiner -> Answer.
// A specialist lights up when the router gives it a task, pulses while it
// works, and shows its time when done. Left to right on wide screens; top
// to bottom on phones, where the wide map would shrink below reading size.
const WIDE = {
  W: 640, H: 250, nodeW: 136,
  you: [46, 125], router: [168, 125], combine: [506, 125], answer: [600, 125],
  spec: SPECIALISTS.map((_, i) => [336, 25 + i * 50]),
};
const TALL = {
  W: 340, H: 380, nodeW: 136,
  you: [170, 20], router: [170, 80], combine: [170, 300], answer: [170, 358],
  spec: [[90, 140], [250, 140], [90, 190], [250, 190], [170, 240]],
};

function AgentMap({ run }) {
  const tall = !Grid.useBreakpoint().sm;
  const L = tall ? TALL : WIDE;
  const { W, H } = L;
  const assigned = new Set(run.tasks.map((t) => t.agent));
  const started = run.phase !== "idle";
  const routed = run.tasks.length > 0;
  const allDone = routed && run.tasks.every((t) => run.agents[t.agent]?.status === "done");
  const combineOn = run.combining || (allDone && run.tasks.length > 0);
  const answered = Boolean(run.answer);
  const state = (agent) => run.agents[agent]?.status ?? (assigned.has(agent) ? "assigned" : "off");

  // An edge leaves a node's right side (wide) or bottom (tall).
  const out = ([x, y], w) => (tall ? [x, y + 17] : [x + w / 2, y]);
  const into = ([x, y], w) => (tall ? [x, y - 17] : [x - w / 2, y]);
  const edge = (from, to, on, key) => {
    const [x1, y1] = from;
    const [x2, y2] = to;
    const d = tall
      ? `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`
      : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
    return <path key={key} d={d} className={`edge${on ? " on" : ""}`} />;
  };

  return (
    <svg className={`agentmap${tall ? " tall" : ""}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Which agents are working on the question">
      {edge(out(L.you, 60), into(L.router, 76), started, "e0")}
      {SPECIALISTS.map((a, i) => edge(out(L.router, 76), into(L.spec[i], L.nodeW), assigned.has(a), `r${a}`))}
      {SPECIALISTS.map((a, i) => edge(out(L.spec[i], L.nodeW), into(L.combine, 76), state(a) === "done", `c${a}`))}
      {edge(out(L.combine, 76), into(L.answer, 60), answered, "e9")}

      <Node x={L.you[0]} y={L.you[1]} w={60} label="You" on={started} />
      <Node x={L.router[0]} y={L.router[1]} w={76} label="Router" on={started} busy={run.phase === "routing"} />
      {SPECIALISTS.map((a, i) => {
        const s = state(a);
        const ms = run.agents[a]?.latencyMs;
        return (
          <Node
            key={a}
            x={L.spec[i][0]}
            y={L.spec[i][1]}
            w={L.nodeW}
            label={AGENT_LABELS[a]}
            sub={s === "done" && ms != null ? `${(ms / 1000).toFixed(1)} s` : s === "running" ? "working" : null}
            color={AGENT_COLORS[a]}
            on={s !== "off"}
            busy={s === "running"}
            done={s === "done"}
          />
        );
      })}
      <Node x={L.combine[0]} y={L.combine[1]} w={76} label="Combiner" on={Boolean(combineOn)} busy={run.combining === true} />
      <Node x={L.answer[0]} y={L.answer[1]} w={60} label="Answer" on={answered} done={run.phase === "done"} />
    </svg>
  );
}

function Node({ x, y, w, label, sub, color, on, busy, done }) {
  return (
    <g className={`node${on ? " on" : ""}${busy ? " busy" : ""}${done ? " done" : ""}`} transform={`translate(${x - w / 2},${y - 17})`} style={color ? { "--node": color } : undefined}>
      <rect width={w} height={34} rx={17} />
      {color && <circle cx={15} cy={17} r={4} />}
      <text x={color ? w / 2 + 6 : w / 2} y={sub ? 15 : 21} textAnchor="middle">
        {label}
      </text>
      {sub && (
        <text x={color ? w / 2 + 6 : w / 2} y={27} textAnchor="middle" className="node-sub">
          {sub}
        </text>
      )}
    </g>
  );
}

// The hand-offs, as messages between the agents.
function CommsLog({ run }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [run.log.length]);
  if (!run.log.length) return null;
  const t0 = run.startedAt;
  return (
    <ol className="comms" ref={ref} aria-label="Agent log">
      {run.log.map((l, i) => (
        <li key={i}>
          <span className="comms-t">+{((l.at - t0) / 1000).toFixed(1)}s</span>
          <span className="comms-who">
            {l.from}
            {l.to && <span className="muted"> → {l.to}</span>}
          </span>
          <span className="comms-text">{l.text}</span>
        </li>
      ))}
    </ol>
  );
}

// --- usage panels ---

function UsagePanels({ d }) {
  // undefined: closed; null: every app; a name: that app's failures.
  const [errorsFor, setErrorsFor] = useState(undefined);
  const callers = [...new Set([...d.byApp.map((a) => a.caller), ...d.connectedApps.flatMap((a) => (a.callers ?? []).filter((c) => c !== "web")), "web"])];
  const colors = callerColors(callers);
  const totalCost = d.totals.costUsd;
  const errorRate = d.totals.questions ? d.totals.errors / d.totals.questions : 0;

  // Every app that may ask, used or not - an app with no use is worth seeing too.
  const rows = callers
    .map((c) => d.byApp.find((a) => a.caller === c) ?? { caller: c, questions: 0, questions_today: 0, errors: 0, voice: 0, files: 0, users: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, last_at: null })
    .sort((a, b) => b.cost_usd - a.cost_usd || b.questions - a.questions);

  const columns = [
    {
      title: "App",
      dataIndex: "caller",
      render: (c) => (
        <span className="app-cell">
          <i style={{ background: colors[c] }} />
          {callerLabel(c)}
        </span>
      ),
    },
    { title: "Questions", dataIndex: "questions", align: "right", render: fmtInt, sorter: (a, b) => a.questions - b.questions },
    { title: "Today", dataIndex: "questions_today", align: "right", render: fmtInt, responsive: ["md"] },
    { title: "Users", dataIndex: "users", align: "right", render: (v) => (v ? fmtInt(v) : "—"), responsive: ["lg"] },
    { title: "Voice", dataIndex: "voice", align: "right", render: fmtInt, responsive: ["lg"] },
    { title: "Files", dataIndex: "files", align: "right", render: fmtInt, responsive: ["xl"] },
    { title: "Tokens", key: "tokens", align: "right", render: (_, r) => fmtTokens(r.prompt_tokens + r.completion_tokens), responsive: ["sm"] },
    {
      title: "Est. cost",
      dataIndex: "cost_usd",
      align: "right",
      sorter: (a, b) => a.cost_usd - b.cost_usd,
      render: (v) => (
        <span className="cost-cell">
          <span className="share">
            <span style={{ width: `${totalCost ? (v / totalCost) * 100 : 0}%` }} />
          </span>
          {fmtUsd(v)}
        </span>
      ),
    },
    {
      title: "Errors",
      dataIndex: "errors",
      align: "right",
      render: (v, r) =>
        v ? (
          <Tag color="error" className="clickable" onClick={() => setErrorsFor(r.caller)}>
            {v}
          </Tag>
        ) : (
          <span className="muted">0</span>
        ),
      responsive: ["md"],
    },
    { title: "Last used", dataIndex: "last_at", render: (v) => (v ? <When at={v} /> : <span className="muted">never</span>), responsive: ["lg"] },
  ];

  const unpriced = d.byModel.filter((m) => !m.priced);
  return (
    <>
      <FailuresDrawer d={d} app={errorsFor} colors={colors} onClose={() => setErrorsFor(undefined)} />
      <div className="kpis">
        <Kpi label="Questions today" value={fmtInt(d.totals.questionsToday)} />
        <Kpi label={`Questions, ${d.days} days`} value={fmtInt(d.totals.questions)} />
        <Kpi label="Est. cost" value={fmtUsd(totalCost)} hint="What this use would cost at the providers' paid prices. On free tiers the bill is $0." />
        <Kpi label="Tokens" value={fmtTokens(d.totals.tokens)} />
        <Kpi label="Typical answer" value={fmtMs(d.totals.p50Ms)} hint={`Half of the answers took less than this. 95% took less than ${fmtMs(d.totals.p95Ms)}.`} />
        <Kpi
          onClick={() => setErrorsFor(null)}
          label="Errors"
          value={
            <span className={errorRate > 0.05 ? "bad" : undefined}>
              {errorRate > 0.05 ? <CloseCircleFilled /> : <CheckCircleFilled className="good" />} {(errorRate * 100).toFixed(errorRate && errorRate < 0.1 ? 1 : 0)}%
            </span>
          }
          hint={`${fmtInt(d.totals.errors)} failed requests - tap to see what failed`}
        />
      </div>

      <div className="cc-grid">
        {d.freeTier?.length > 0 && (
          <Card className="span2" title="Free tier today" size="small" extra={<span className="muted small">What is left before the free limits stop the service</span>}>
            <FreeTier rows={d.freeTier} />
          </Card>
        )}

        <Card className="span2" title="Questions per day" size="small">
          <DailyChart rows={d.byDay} days={d.days} colors={colors} />
        </Card>

        <Card className="span2" title="Billing by app" size="small" extra={<span className="muted small">Each app's own key is its billing identity</span>}>
          <Table size="small" rowKey="caller" columns={columns} dataSource={rows} pagination={false} scroll={{ x: true }} />
        </Card>

        <Card title="Agents" size="small" extra={<span className="muted small">Requests handled</span>}>
          <BarList items={d.byAgent.map((a) => ({ key: a.agent, label: AGENT_LABELS[a.agent] ?? a.agent.replace("_", " "), value: a.requests, dot: AGENT_COLORS[a.agent] }))} />
        </Card>

        <Card title="Models" size="small" extra={<span className="muted small">Est. cost</span>}>
          <BarList items={d.byModel.map((m) => ({ key: m.model, label: `${m.model.replace(/^openai\//, "")} · ${fmtInt(m.calls)} calls`, value: m.cost_usd }))} format={fmtUsd} empty="No model calls yet" />
          {unpriced.length > 0 && <p className="muted small">No price set for {unpriced.map((m) => m.model).join(", ")} - add it to MODEL_PRICES.</p>}
        </Card>

        <Card title="Top users" size="small" extra={<span className="muted small">Inside apps that say who asks</span>}>
          {d.byUser?.length ? (
            <Table
              size="small"
              rowKey={(r) => `${r.caller}:${r.user_ref}`}
              pagination={false}
              dataSource={d.byUser}
              columns={[
                {
                  title: "User",
                  key: "user",
                  render: (_, r) => (
                    <span className="app-cell">
                      <i style={{ background: colors[r.caller] ?? "var(--other)" }} />
                      <span className="mono">{r.user_ref}</span>
                    </span>
                  ),
                },
                { title: "Questions", dataIndex: "questions", align: "right", render: fmtInt },
                { title: "Est. cost", dataIndex: "cost_usd", align: "right", render: fmtUsd },
                { title: "Last", dataIndex: "last_at", align: "right", render: (v) => <When at={v} />, responsive: ["sm"] },
              ]}
            />
          ) : (
            <p className="muted small">No app has sent who is asking yet. An app sends it as user.ref on /api/ask - the masjid app sends the member code, or an anonymous code for visitors.</p>
          )}
        </Card>

        <Card title="Connected-app calls" size="small" extra={<span className="muted small">What the agents read from apps</span>}>
          {d.appCalls.length ? (
            <Table
              size="small"
              rowKey={(r) => `${r.app}:${r.operation}`}
              pagination={false}
              dataSource={d.appCalls}
              columns={[
                { title: "Call", key: "op", render: (_, r) => <span className="mono">{r.app} · {r.operation}</span> },
                { title: "Calls", dataIndex: "calls", align: "right", render: fmtInt },
                { title: "Failed", dataIndex: "failures", align: "right", render: (v) => (v ? <Tag color="error">{v}</Tag> : <span className="muted">0</span>) },
                { title: "Avg", dataIndex: "avg_ms", align: "right", render: fmtMs },
              ]}
            />
          ) : (
            <p className="muted small">No app calls yet</p>
          )}
        </Card>

        <Card className="span2" title="Recent requests" size="small" extra={<span className="muted small">Newest first · no question text is stored</span>}>
          <ul className="recent">
            {d.recent.map((r, i) => (
              <li key={i}>
                {r.ok ? <CheckCircleFilled className="good" /> : <Tooltip title={r.error}><CloseCircleFilled className="bad" /></Tooltip>}
                <span className="app-cell">
                  <i style={{ background: colors[r.caller] ?? "var(--other)" }} />
                  {callerLabel(r.caller)}
                </span>
                <span className="muted">{r.channel}</span>
                <span className="recent-agents">
                  {(r.agents ?? []).map((a) => (
                    <span key={a} className="chip" style={{ "--node": AGENT_COLORS[a] ?? "var(--other)" }}>
                      {AGENT_LABELS[a] ?? a.replace("_", " ")}
                    </span>
                  ))}
                </span>
                <span className="recent-nums">
                  <span className="muted num">{fmtTokens(r.tokens)} tok</span>
                  <span className="num">{fmtUsd(r.cost_usd)}</span>
                  <span className="muted num">{fmtMs(r.latency_ms)}</span>
                  <When at={r.at} className="muted num when" />
                </span>
              </li>
            ))}
            {!d.recent.length && <li className="muted">No requests yet - ask something above.</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}

function Kpi({ label, value, hint, onClick }) {
  const body = (
    <div
      className={`kpi${onClick ? " clickable" : ""}`}
      {...(onClick ? { role: "button", tabIndex: 0, onClick, onKeyDown: (e) => (e.key === "Enter" || e.key === " ") && onClick() } : {})}
    >
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}

// What failed: every failed request in the period (with its error), and
// answered questions where a call to a connected app failed. Opened from the
// Errors tile (all apps) or an app's error count in the billing table.
const CHANNEL_LABELS = { chat: "Chat", ask: "App question", transcribe: "Voice to text", attachment: "File", speak: "Read aloud" };
function FailuresDrawer({ d, app, colors, onClose }) {
  const open = app !== undefined;
  const rows = (d.failures ?? []).filter((f) => !app || f.caller === app);
  const narrow = !Grid.useBreakpoint().sm;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement={narrow ? "bottom" : "right"}
      // Inside the Command Center, so it has its colours and styles.
      getContainer={() => document.querySelector(".cc") ?? document.body}
      size={narrow ? "large" : "default"}
      title={`What failed${app ? ` - ${callerLabel(app)}` : ""}, last ${d.days} days`}
      extra={<span className="muted small">{rows.filter((f) => !f.ok).length} failed</span>}
    >
      {!rows.length && <p className="muted">Nothing failed in this period.</p>}
      <ul className="failures">
        {rows.map((f, i) => {
          // A 403 is the app refusing what this user may not see (a member
          // asking for the accounts) - the role rules working, not a fault.
          const calls = f.failed_app_calls ?? [];
          const onlyRefusals = f.ok && calls.length > 0 && calls.every((c) => c.status === 403);
          return (
          <li key={i} className={onlyRefusals ? "refusal" : undefined}>
            <div className="failure-head">
              {!f.ok ? <Tag color="error">failed</Tag> : onlyRefusals ? <Tag>refused for this user (expected)</Tag> : <Tag color="warning">answered, an app call failed</Tag>}
              <span className="app-cell">
                <i style={{ background: colors[f.caller] ?? "var(--other)" }} />
                {callerLabel(f.caller)}
              </span>
              <span className="muted">{CHANNEL_LABELS[f.channel] ?? f.channel}</span>
              <span className="grow" />
              <When at={f.at} className="muted num" />
            </div>
            {f.error && <div className="failure-error">{f.error}</div>}
            {calls.map((c, k) => (
              <div key={k} className={c.status === 403 ? "failure-note" : "failure-error"}>
                {c.app} · {c.operation}: {c.status === 403 ? "not allowed for this user" : c.status ? `HTTP ${c.status}` : "no answer"}
                {c.latencyMs != null ? ` after ${fmtMs(c.latencyMs)}` : ""}
              </div>
            ))}
            <div className="muted small">
              {[f.user_ref && `user ${f.user_ref}`, (f.agents ?? []).length && `agents: ${f.agents.map((a) => AGENT_LABELS[a] ?? a).join(", ")}`, f.latency_ms != null && `took ${fmtMs(f.latency_ms)}`].filter(Boolean).join(" · ")}
            </div>
          </li>
          );
        })}
      </ul>
    </Drawer>
  );
}

// When something happened: the time alone for today, "Yesterday 6:38 PM",
// or the date for older ones. Tap (phone) or hover (computer) for the full
// date and time.
function When({ at, className = "muted num" }) {
  const t = new Date(at).getTime();
  const day = dayLabel(t);
  return (
    <Tooltip title={fullTime(t)} trigger={["hover", "click"]}>
      <span className={`${className} when-label`} tabIndex={0}>
        {day === "Today" ? shortTime(t) : `${day} ${shortTime(t)}`}
      </span>
    </Tooltip>
  );
}

// How much of each free tier is left today (api/limits.js). Requests left
// are Groq's own figure when it has given one, else this service's count -
// the Mac's evals use the same keys but are not counted here. Gemini does
// not report its limits; the TTS limit (10 a day) is the one its own error
// gave, the others are only shown in AI Studio.
const MODEL_ROLES = {
  "openai/gpt-oss-120b": "answers",
  "openai/gpt-oss-20b": "judging, routing, planning",
  "whisper-large-v3-turbo": "voice to text (backup)",
  "gemini-3.5-flash-lite": "voice to text, photos, overviews",
  "gemini-3.8-flash-lite-tts": "reading aloud (Malayalam ...)",
};
function FreeTier({ rows }) {
  return (
    <div className="freetier">
      {rows.map((m) => {
        const limit = m.requestsPerDay;
        const left = m.requestsLeft;
        const share = limit && left != null ? left / limit : null;
        const tokenShare = m.tokensPerDay ? m.tokensLeft / m.tokensPerDay : null;
        const low = [share, tokenShare].some((x) => x != null && x < 0.2);
        const status = m.usedUpUntil ? (
          <Tag color="error" icon={<CloseCircleFilled />}>
            Used up
          </Tag>
        ) : limit == null ? (
          <Tag>Limit in AI Studio</Tag>
        ) : low ? (
          <Tag color="warning">Low</Tag>
        ) : (
          <Tag color="success" icon={<CheckCircleFilled />}>
            OK
          </Tag>
        );
        return (
          <div className="ft-row" key={m.model}>
            <div className="ft-head">
              <span className="ft-name">{m.model.replace(/^openai\//, "")}</span>
              <span className="muted small">
                {m.provider === "groq" ? "Groq" : m.provider === "gemini" ? "Gemini" : m.provider} · {MODEL_ROLES[m.model] ?? "model"}
              </span>
              <span className="grow" />
              {status}
            </div>
            {limit != null ? (
              <Meter
                share={share}
                text={`${fmtInt(left)} of ${fmtInt(limit)} requests left`}
                note={m.usedUpUntil ? "the provider refused" : m.requestsLeftSource === "provider" ? `Groq's figure` : "our count"}
                at={m.reportedAt}
              />
            ) : (
              <div className="muted small">
                {fmtInt(m.usedToday.requests)} requests today · Gemini shows this limit only in{" "}
                <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noreferrer">
                  AI Studio
                </a>
              </div>
            )}
            {m.tokensPerDay != null && <Meter share={tokenShare} text={`${fmtTokens(m.tokensLeft)} of ${fmtTokens(m.tokensPerDay)} tokens left`} note="our count" />}
            <div className="muted small">
              {m.usedUpUntil ? "Back " : "Resets "}
              <When at={m.usedUpUntil ?? m.resetsAt} className="muted" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
function Meter({ share, text, note, at }) {
  return (
    <div className="ft-meter">
      <span className="ft-track">
        <span style={{ width: `${Math.max(0, Math.min(1, share ?? 0)) * 100}%` }} />
      </span>
      <span className="small">
        {text} <span className="muted">({note}{at ? ", " : ""}{at && <When at={at} className="muted" />})</span>
      </span>
    </div>
  );
}
