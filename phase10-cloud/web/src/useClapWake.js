import { useEffect, useRef, useState } from "react";

// Phase 10e: "clap twice to wake" for the Command Center. While on, it
// listens to the microphone in the browser only - nothing is recorded or
// sent until the double clap, and then only the question that follows
// (useVoiceInput). Works while the page is open and visible.
//
// A clap, as opposed to speech or a door: a sudden jump far above the room's
// background level that dies away within ~150 ms. Speech rises more slowly
// and lasts; music and fans are steady. Two claps 0.2-0.9 s apart wake it,
// which a single knock or a cough does not.
const ONSET_RATIO = 6; // the frame's level against the room's background level
const MIN_PEAK = 0.3; // loudest sample in the frame, 0-1
const DECAY_MS = 160; // a clap must fall away within this...
const DECAY_TO = 0.35; // ...to this share of its level
const GAP = [200, 900]; // ms between the two claps

// status: "off" | "starting" | "listening" | "needs-tap" | "error"
export function useClapWake({ enabled, paused, onWake }) {
  const [status, setStatus] = useState("off");
  const [error, setError] = useState(null);
  const [lastClap, setLastClap] = useState(0); // time of the last clap heard, for a flash in the UI
  const live = useRef({ paused, onWake });
  live.current = { paused, onWake };

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return undefined;
    }
    let stream;
    let ctx;
    let raf;
    let stopped = false;
    setStatus("starting");
    setError(null);
    (async () => {
      try {
        // No noise suppression or auto gain: both flatten exactly the sharp
        // peak a clap is.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (err) {
        if (stopped) return;
        setStatus("error");
        setError(err?.name === "NotAllowedError" ? "Microphone access is blocked - allow it for this site to use clap to wake." : "Could not open the microphone.");
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctx();
      // Browsers start audio suspended until the page has had a tap or a key
      // press - turned on from a remembered setting at page load, the
      // analyser would read silence. Then: ask for one tap.
      await ctx.resume().catch(() => {});
      if (ctx.state !== "running") {
        setStatus("needs-tap");
        await new Promise((resolve) => {
          const go = () => ctx.resume().then(resolve, resolve);
          window.addEventListener("pointerdown", go, { once: true });
          window.addEventListener("keydown", go, { once: true });
        });
        if (stopped) return;
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let background = 0.01;
      let candidate = null; // { t, level }
      let claps = [];
      setStatus("listening");

      const tick = (t) => {
        raf = requestAnimationFrame(tick);
        analyser.getFloatTimeDomainData(data);
        let peak = 0;
        let sum = 0;
        for (const v of data) {
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sum += v * v;
        }
        const level = Math.sqrt(sum / data.length);
        if (candidate) {
          if (level < candidate.level * DECAY_TO) {
            // It died away fast: a clap.
            const at = candidate.t;
            candidate = null;
            if (live.current.paused) return;
            setLastClap(at);
            claps = [...claps.filter((c) => at - c <= GAP[1]), at];
            const first = claps.at(-2);
            if (first !== undefined && at - first >= GAP[0]) {
              claps = [];
              live.current.onWake();
            }
          } else if (t - candidate.t > DECAY_MS) {
            candidate = null; // it lasted: speech, music, not a clap
          }
          return;
        }
        if (peak >= MIN_PEAK && level > background * ONSET_RATIO) {
          candidate = { t, level };
          return;
        }
        // The room's level, following slowly, so a noisy room needs a louder clap.
        background = background * 0.97 + Math.max(level, 0.002) * 0.03;
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
      ctx?.close().catch(() => {});
    };
  }, [enabled]);

  return { status, error, lastClap };
}
