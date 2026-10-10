// Phase 10 UI: voice input. The web app records a question with the
// browser's MediaRecorder and posts the audio here; the text goes into the
// input box for the user to check and send.
//
// Why not the browser's own speech recognition (Web Speech API): Firefox has
// none, iPhone home-screen apps are unreliable with it, and it needs the
// language chosen in advance. Recording works in every browser.
//
// Which model writes the text - measured on Malayalam, English and Hindi
// questions (Malayalam recordings made with Gemini's text-to-speech; macOS
// has no Malayalam voice):
//   Groq Whisper (large-v3, large-v3-turbo): English and Hindi right, but
//     Malayalam came back in Tamil, Gujarati or Gurmukhi script - even with
//     language=ml it was misspelt (turbo) or still Gurmukhi (large-v3). This
//     was the user's report: "malayalam voice not taking".
//   Gemini 3.8 Flash: near perfect, but 11-95 s per question (thinking).
//   Gemini 3.5 Flash Lite: ~1.5 s; all three Malayalam questions right in
//     Malayalam script once told the language (without the hint one came
//     back partly in Arabic script). English and Hindi right.
// So Gemini Flash Lite writes the text, with the language the user picked as
// a hint, and Whisper takes over if Gemini fails or is out of quota.
import { TRANSCRIBE_MODEL, GROQ_API_KEY, GEMINI_API_KEY, GEMINI_TRANSCRIBE_MODEL } from "./config.js";

const WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
// Whisper wants a file name whose extension matches the audio format.
const EXTENSIONS = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };
// Whisper writes a polite sentence ("Thank you.") for silence; segments it
// marks as probably not speech are dropped. (Both models also invent text
// for pure silence with full confidence - the web app does not send a
// recording that never got loud, see useVoiceInput.js.)
const NO_SPEECH = 0.6;
// The languages the web app offers as a hint; anything else is ignored.
const LANGUAGES = new Set(["English", "Malayalam", "Hindi", "Tamil", "Kannada", "Telugu", "Arabic", "Urdu", "Spanish", "French"]);

export const voiceAvailable = Boolean(GEMINI_API_KEY || GROQ_API_KEY);

export class TranscribeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);

async function withGemini(audio, type, language) {
  const prompt =
    (language ? `The speaker is speaking ${language}, possibly mixing in English words. ` : "") +
    "Transcribe this recording of a spoken question exactly as said, in the language spoken, written in that " +
    "language's own script. Output only the transcript, nothing else. If there is no speech, output nothing.";
  const res = await fetch(GEMINI_URL(GEMINI_TRANSCRIBE_MODEL), {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: type, data: Buffer.from(audio).toString("base64") } }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TranscribeError(`Gemini ${res.status}: ${detail.slice(0, 200)}`, res.status);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  return { text: text.replace(/^["“]|["”]$/g, ""), language: language ?? null, by: GEMINI_TRANSCRIBE_MODEL };
}

async function withWhisper(audio, type, ext) {
  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("file", new Blob([audio], { type }), `question.${ext}`);
  const res = await fetch(WHISPER_URL, { method: "POST", headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: form });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    const when = wait ? ` - try again in about ${Math.max(1, Math.ceil(wait / 60))} minute(s)` : "";
    throw new TranscribeError(`Voice input's free limit is used up for now${when}. You can still type.`, 429);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TranscribeError(`Whisper ${res.status}: ${detail.slice(0, 200)}`, 502);
  }
  const data = await res.json();
  const segments = data.segments ?? [];
  const text = (segments.length ? segments.filter((s) => (s.no_speech_prob ?? 0) < NO_SPEECH).map((s) => s.text).join("") : data.text ?? "").trim();
  return { text, language: data.language ?? null, by: TRANSCRIBE_MODEL };
}

export async function transcribe(audio, contentType, languageHint) {
  if (!voiceAvailable) throw new TranscribeError("Voice input needs GEMINI_API_KEY or GROQ_API_KEY on the server.", 501);
  const type = (contentType ?? "").split(";")[0].trim();
  const ext = EXTENSIONS[type];
  if (!ext) throw new TranscribeError(`Unsupported audio format: ${type || "none"}`, 415);
  if (!audio?.length) throw new TranscribeError("No audio received.", 400);
  const language = LANGUAGES.has(languageHint) ? languageHint : undefined;

  let result;
  if (GEMINI_API_KEY) {
    try {
      result = await withGemini(audio, type, language);
    } catch (err) {
      if (!GROQ_API_KEY) throw new TranscribeError("Could not turn the recording into text. Please try again.", 502);
      console.error(`[transcribe] ${err.message} - using Whisper instead`);
    }
  }
  if (!result) {
    try {
      result = await withWhisper(audio, type, ext);
    } catch (err) {
      if (err.status === 429) throw err;
      console.error(`[transcribe] ${err.message}`);
      throw new TranscribeError("Could not turn the recording into text. Please try again.", 502);
    }
  }
  // Silence can still come back as a lone "." - no letter or digit means nothing was said.
  return { ...result, text: hasWords(result.text) ? result.text : "" };
}
