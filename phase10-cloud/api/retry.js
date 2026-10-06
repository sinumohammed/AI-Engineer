// Shared retry helper with exponential backoff. Used to wrap network calls
// to Ollama (chat + embeddings) that can transiently fail - a busy GPU, a
// brief connection drop - without those turning into a hard failure for the
// user on the first hiccup. Not every failure should be retried: a genuine
// 400 (bad request) will fail identically every time, so only network-level
// errors and 5xx/429 (server overloaded/rate-limited) responses are retried.
export async function withRetry(fn, { retries = 3, baseDelayMs = 500, label = "operation" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = isRetryable(err);
      if (!retryable || attempt === retries) throw err;

      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function isRetryable(err) {
  // Network-level failures (connection refused, timeout, DNS, etc) - these
  // come from fetch itself throwing, not from a response with a status code.
  if (err instanceof TypeError) return true;
  if (err.cause?.code) return true; // e.g. UND_ERR_HEADERS_TIMEOUT, ECONNRESET

  // HTTP errors we deliberately tag with a status - only retry server-side/
  // overload conditions, never a 4xx like "bad request" that will just fail
  // identically every time.
  if (typeof err.status === "number") return err.status >= 500 || err.status === 429;

  return false;
}
