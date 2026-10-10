// Phase 10: one call to Google's Gemini API, shared by voice input
// (transcribe.js) and attachments (attachments.js) - the jobs the Groq
// models cannot do: hearing Malayalam, and reading photos and scanned pages.
import { GEMINI_API_KEY } from "./config.js";

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
export async function geminiText(model, parts, { thinking } = {}) {
  if (!GEMINI_API_KEY) throw new GeminiError("GEMINI_API_KEY is not set", 501);
  const res = await fetch(URL(model), {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GeminiError(`Gemini ${res.status}: ${detail.slice(0, 200)}`, res.status);
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
}
