// Phase 10: one call to Google's Gemini API, shared by voice input
// (transcribe.js) and attachments (attachments.js) - the jobs the Groq
// models cannot do: hearing Malayalam, and reading photos and scanned pages.
import { GEMINI_API_KEY, GEMINI_TTS_MODEL, GEMINI_TTS_VOICE } from "./config.js";
import { recordModel } from "./usage.js";
import { noteExhausted } from "./limits.js";

const URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// parts: [{ text }] and/or [{ inlineData: { mimeType, data: base64 } }]
// thinking: "minimal" | "low" | ... - how much Gemini reasons before writing.
// Reading a photo or scan took 1.4-2 s at every level (one first call took
// 16-18 s); "low" keeps it predictable with the same accuracy.
// timeoutMs: give up after this long (the fetch throws a TimeoutError).
export async function geminiText(model, parts, { thinking, timeoutMs } = {}) {
  if (!GEMINI_API_KEY) throw new GeminiError("GEMINI_API_KEY is not set", 501);
  const res = await fetch(URL(model), {
    method: "POST",
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429 && /per ?day/i.test(detail)) await noteExhausted(model, detail); // limits.js
    throw new GeminiError(`Gemini ${res.status}: ${detail.slice(0, 200)}`, res.status);
  }
  const data = await res.json();
  // Phase 10e: thinking tokens are billed as output (usage.js).
  const u = data.usageMetadata ?? {};
  recordModel({ provider: "gemini", model, label: "gemini", promptTokens: u.promptTokenCount ?? 0, completionTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) });
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
}

// Phase 10e: text to speech - a WAV (24 kHz, mono, 16-bit) of the text, in
// whatever language it is written (the model detects it). Through the
// Interactions API, where the TTS models live.
export async function geminiSpeech(text, { timeoutMs = 60000 } = {}) {
  if (!GEMINI_API_KEY) throw new GeminiError("GEMINI_API_KEY is not set", 501);
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMINI_TTS_MODEL,
      input: [{ type: "user_input", content: [{ type: "text", text }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: GEMINI_TTS_VOICE }] },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429 && /per ?day/i.test(detail)) await noteExhausted(GEMINI_TTS_MODEL, detail); // limits.js
    throw new GeminiError(`Gemini speech ${res.status}: ${detail.slice(0, 200)}`, res.status);
  }
  const data = await res.json();
  const audio = (data.steps ?? []).flatMap((s) => s.content ?? []).find((c) => c.type === "audio");
  if (!audio?.data) throw new GeminiError("Gemini returned no audio", 502);
  recordModel({ provider: "gemini", model: GEMINI_TTS_MODEL, label: "speech", promptTokens: data.usage?.total_input_tokens ?? 0, completionTokens: data.usage?.total_output_tokens ?? 0 });
  return Buffer.from(audio.data, "base64");
}
