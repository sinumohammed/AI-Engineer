import { useEffect, useRef } from "react";
import { sharedAudioContext } from "./useVoiceInput.js";

// Phase 10e, conversation mode: talk over the answer to interrupt it. While
// on, listens to the microphone (in the browser only) and calls onSpeech
// when the user has been clearly speaking for SUSTAIN_MS. The bar is higher
// than for recording, and echo cancellation is on, so the answer coming out
// of the speaker should not count as the user - with headphones it cannot.
const LOUD = 0.12; // the same 0-1 scale as useVoiceInput's meter
const SUSTAIN_MS = 300;
const IGNORE_FIRST_MS = 400; // the speaker starting up is not the user

export function useBargeIn({ enabled, onSpeech }) {
  const live = useRef(onSpeech);
  live.current = onSpeech;

  useEffect(() => {
    if (!enabled) return undefined;
    let stream;
    let ctx;
    let own = false;
    let source;
    let raf;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      } catch {
        return; // no mic: tapping the orb still interrupts
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      ctx = sharedAudioContext();
      if (!ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        ctx = new Ctx();
        own = true;
        await ctx.resume().catch(() => {});
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const begun = performance.now();
      let loudSince = null;
      const tick = (t) => {
        raf = requestAnimationFrame(tick);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += (v - 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / data.length) / 40);
        if (t - begun < IGNORE_FIRST_MS) return;
        if (level >= LOUD) {
          loudSince ??= t;
          if (t - loudSince >= SUSTAIN_MS) {
            cancelAnimationFrame(raf);
            live.current();
          }
        } else {
          loudSince = null;
        }
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      source?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      if (own) ctx?.close().catch(() => {});
    };
  }, [enabled]);
}
