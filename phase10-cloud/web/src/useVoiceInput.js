import { useEffect, useRef, useState } from "react";
import { API_BASE, codeHeaders } from "./useChatSession.js";

// Phase 10 UI: voice input. Records with MediaRecorder (every current
// browser, including iPhone home-screen apps), sends the audio to the API,
// and hands back the text (api/transcribe.js - Groq Whisper, which detects
// the language itself).
const MAX_SECONDS = 120; // the API accepts ~4 MB; two minutes of Opus is ~1 MB
const BARS = 28;
// The loudest moment of a recording must reach this level (0-1, see the
// meter below) or it is not sent. Whisper does not return nothing for
// silence - it writes "Thank you." with full confidence (no_speech_prob 0
// on a silent recording), so the server cannot filter it; here it is caught
// before it uses any quota.
const MIN_PEAK = 0.04;
// Chrome/Firefox/Edge record WebM/Opus, Safari MP4/AAC.
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export const voiceSupported = () =>
  typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder !== "undefined";

function friendlyError(err) {
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError")
    return "Microphone access is blocked. Allow it for this site in your browser settings, then try again.";
  if (err?.name === "NotFoundError") return "No microphone was found.";
  return err?.message || "Could not record.";
}

// Phase 10e, for the Command Center: with silenceMs, the recording stops by
// itself once the user has spoken and then been quiet that long, or after
// NO_SPEECH_MS if nothing was said - the masjid app's tested values. Between
// the two levels nothing changes, so breathing or a fan does not end it.
const SPEAKING = 0.07;
const QUIET = 0.035;
const NO_SPEECH_MS = 8000;

// Phase 10e, conversation mode: one audio context, started inside the user's
// first tap and then reused, so listening that starts by itself later (the
// next turn of a conversation) still gets a working level meter on a phone -
// a new context there would stay paused without a tap.
let sharedCtx = null;
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedCtx ??= new Ctx();
    sharedCtx.resume().catch(() => {});
  } catch {
    // no Web Audio
  }
}
export const sharedAudioContext = () => (sharedCtx?.state === "running" ? sharedCtx : null);

// status: "idle" | "recording" | "transcribing"
export function useVoiceInput({ onText, onError, language, silenceMs = 0 }) {
  const [status, setStatus] = useState("idle");
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState(() => Array(BARS).fill(0));
  const rec = useRef(null); // { recorder, stream, chunks, audioCtx, raf, timer, cancelled }
  // Set from the moment start() is called: the status only changes once the
  // mic is open, and two starts in that gap would open two recordings.
  const starting = useRef(false);
  // The latest callbacks: a recording ends several renders after it started.
  const callbacks = useRef({ onText, onError, language });
  callbacks.current = { onText, onError, language };

  function release() {
    const r = rec.current;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop()); // the mic indicator goes off
    r.source?.disconnect();
    if (r.audioCtx && r.audioCtx !== sharedCtx) r.audioCtx.close().catch(() => {});
  }

  useEffect(() => () => release(), []);

  async function start() {
    if (status !== "idle" || starting.current || rec.current) return;
    starting.current = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      starting.current = false;
      callbacks.current.onError(friendlyError(err));
      return;
    }
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const r = { recorder, stream, chunks: [], cancelled: false, peak: null };
    rec.current = r;
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    recorder.onstop = () => finish(r);

    // A live level meter, so it is obvious the mic is hearing you.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      r.audioCtx = sharedAudioContext() ?? new Ctx();
      // Started without a tap (clap to wake), a phone keeps audio paused: the
      // meter would read silence, so the recording would never stop by itself
      // and would be thrown away as silent. Then: no meter - it is sent as it
      // is, and the user taps to stop.
      await r.audioCtx.resume().catch(() => {});
      if (r.audioCtx.state !== "running") throw new Error("audio paused");
      const analyser = r.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      r.source = r.audioCtx.createMediaStreamSource(stream);
      r.source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let last = 0;
      const begun = performance.now();
      const tick = (t) => {
        r.raf = requestAnimationFrame(tick);
        if (t - last < 70) return;
        last = t;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += (v - 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / data.length) / 40);
        r.peak = Math.max(r.peak ?? 0, level);
        setLevels((prev) => [...prev.slice(1), level]);
        if (silenceMs && r.recorder.state === "recording") {
          if (level >= SPEAKING) {
            r.heard = true;
            r.lastLoud = t;
          } else if (level >= QUIET) {
            r.lastLoud = t; // still sounding - not a pause yet
          }
          if ((r.heard && t - r.lastLoud > silenceMs) || (!r.heard && t - begun > NO_SPEECH_MS)) r.recorder.stop();
        }
      };
      r.raf = requestAnimationFrame(tick);
    } catch {
      // no meter - recording still works, sent without the silence check
      if (r.audioCtx && r.audioCtx !== sharedCtx) r.audioCtx.close().catch(() => {});
      r.audioCtx = null;
      r.peak = null;
    }

    const startedAt = Date.now();
    setSeconds(0);
    setLevels(Array(BARS).fill(0));
    r.timer = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) stop();
    }, 250);
    recorder.start();
    starting.current = false;
    setStatus("recording");
  }

  // Stop and turn the recording into text.
  function stop() {
    const r = rec.current;
    if (r?.recorder.state === "recording") r.recorder.stop();
  }

  // Stop and throw the recording away.
  function cancel() {
    const r = rec.current;
    if (!r) return;
    r.cancelled = true;
    if (r.recorder.state === "recording") r.recorder.stop();
  }

  async function finish(r) {
    release();
    rec.current = null;
    if (r.cancelled || !r.chunks.length) {
      setStatus("idle");
      return;
    }
    // peak stays null when there was no meter (no Web Audio): send anyway.
    if (r.peak !== null && r.peak < MIN_PEAK) {
      setStatus("idle");
      callbacks.current.onError("I didn't hear anything - check that the right microphone is on, and try again.");
      return;
    }
    setStatus("transcribing");
    const type = r.recorder.mimeType || r.chunks[0].type || "audio/webm";
    try {
      // The language the user picked is a hint for the model: without it, a
      // Malayalam question can come back romanised or in another script.
      const lang = callbacks.current.language;
      const query = lang && lang !== "auto" ? `?lang=${encodeURIComponent(lang)}` : "";
      const res = await fetch(`${API_BASE}/api/transcribe${query}`, {
        method: "POST",
        headers: { "Content-Type": type, ...codeHeaders() },
        body: new Blob(r.chunks, { type }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Voice input failed (${res.status}).`);
      if (!data.text) callbacks.current.onError("I didn't catch anything - try again, a little closer to the mic.");
      else callbacks.current.onText(data.text, data.language);
    } catch (err) {
      callbacks.current.onError(err.message === "Failed to fetch" ? "Connection lost - check your internet and try again." : err.message);
    } finally {
      setStatus("idle");
    }
  }

  // Recording, transcribing, or about to start.
  const active = () => starting.current || Boolean(rec.current) || status !== "idle";
  return { status, seconds, levels, start, stop, cancel, active, maxSeconds: MAX_SECONDS };
}
