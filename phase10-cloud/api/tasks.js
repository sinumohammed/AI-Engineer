// Phase 10 step 5: small AI jobs for connected apps that are not questions -
// "draft a quote from this complaint", "read this registration card". The app
// sends its own instructions and either text or one photo; the answer is the
// model's JSON, as an object. Keys, models, limits and metering stay in this
// service (askApi.js POST /api/ask/task), so an app holds no AI key of its own.
//
// Photos go to a Groq vision model, never Gemini: an app's photos (a car's
// registration card) carry personal data, and Gemini's free tier may use
// inputs to improve Google's products (dataPolicy.js). Groq does not train on
// API data and Zero Data Retention is on.
import { chat } from "./llmClient.js";
import { LLM_FORMAT, JUDGE_MODEL, JUDGE_REASONING_EFFORT } from "./config.js";

export const TASK_MODEL = process.env.TASK_MODEL || JUDGE_MODEL;
export const VISION_MODEL = process.env.VISION_MODEL || "meta-llama/llama-4-maverick-17b-128e-instruct";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_TEXT = 8000;
const MAX_IMAGE_CHARS = 4_400_000; // base64; Vercel takes request bodies up to 4.5 MB

export class TaskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// { instructions, input?, image?: { mimeType, data } } -> the checked request, or a TaskError.
export function parseTask(body) {
  const { instructions, input = "", image } = body ?? {};
  if (typeof instructions !== "string" || !instructions.trim()) throw new TaskError('Missing "instructions" (a string): what to do and the JSON to reply with.');
  if (instructions.length > MAX_TEXT || typeof input !== "string" || input.length > MAX_TEXT) throw new TaskError(`"instructions" and "input" are strings of up to ${MAX_TEXT} characters.`);
  if (image !== undefined) {
    if (!image || !IMAGE_TYPES.includes(image.mimeType) || typeof image.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(image.data)) {
      throw new TaskError('"image" must be { "mimeType": "image/jpeg" | "image/png" | "image/webp", "data": "<base64>" }.');
    }
    if (image.data.length > MAX_IMAGE_CHARS) throw new TaskError("The image is too big - up to about 3 MB.", 413);
  }
  if (!input.trim() && !image) throw new TaskError('Send "input" (text), "image", or both.');
  return { instructions: instructions.trim(), input: input.trim(), image };
}

// The reply's JSON object; models sometimes wrap it in a code fence or a sentence.
function jsonOf(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function runTask({ instructions, input, image }) {
  if (image && LLM_FORMAT !== "openai") throw new TaskError("Reading photos needs the hosted model (LLM_PROVIDER=groq).", 501);
  const model = image ? VISION_MODEL : TASK_MODEL;
  const system = `${instructions}\n\nReply with one JSON object only - no other text.`;
  const user = image
    ? [{ type: "text", text: input || "Read this image." }, { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }]
    : input;
  // Text tasks run like the judge (same model and effort); the vision model does not think first.
  const res = await chat({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], label: image ? "task-vision" : "task", reasoningEffort: image ? null : JUDGE_REASONING_EFFORT });
  const result = jsonOf(res.content ?? "");
  if (!result) throw new TaskError("The model's reply was not JSON - please try again.", 502);
  return { result, model };
}
