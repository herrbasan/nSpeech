/**
 * Cloud adapter error mapping — one place that turns an upstream provider
 * failure into the nSpeech API error contract (status + code).
 *
 * Why this exists: a plain Error thrown from an adapter reaches the routes'
 * sendError() with no `status`, so every upstream 4xx became
 * `503 engine_error` / `code: unknown`. Consequences:
 *   - a caller can't tell a bad request from an outage;
 *   - a client won't back off on a rate limit it never sees;
 *   - the SDK's RateLimitError and VoiceNotFoundError are unreachable for
 *     cloud engines, because nSpeech never returned those statuses.
 *
 * Each adapter passes whatever its provider actually returned; this maps the
 * statuses the providers share (HTTP semantics are the common ground) and
 * keeps the provider's own message.
 *
 * WorkerError is the shared error type every route's sendError() already
 * understands: adapters implement the same contract as WorkerProcess, errors
 * included. `WorkerError.toJSON()` derives `type` from the status, so a 4xx
 * comes back as `invalid_request_error` and a 5xx as `engine_error`.
 */
import { WorkerError } from '../engine/worker.js';

/**
 * Pull a human-readable message out of a provider error body. Providers differ:
 * some use `{error: "text"}`, some `{error: {message}}`, some `{detail}`, and
 * MiniMax nests its own status in `{base_resp: {status_msg}}`.
 *
 * @param {string} text — the raw response body
 * @returns {string}
 */
export function providerMessage(text) {
  if (!text) return 'no response body';
  try {
    const parsed = JSON.parse(text);
    const e = parsed.error;
    const msg =
      (typeof e === 'string' ? e : e?.message) ||
      parsed.message ||
      parsed.detail ||
      parsed.base_resp?.status_msg;
    if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch {
    // Not JSON — the raw text is the message.
  }
  return text;
}

/**
 * Build a WorkerError from an upstream HTTP failure.
 *
 * @param {number} status — the provider's HTTP status
 * @param {string} body   — the provider's raw error body
 * @param {string} what   — what was being attempted, e.g. "ElevenLabs TTS failed"
 * @param {string} [notFoundCode] — code to use for a 404. Defaults to
 *   `voice_not_found`, which is right for voice operations; a synthesis path
 *   that 404s on an unknown *model* passes `model_not_found` instead. A blind
 *   404 → voice_not_found mislabels a model error as a voice error.
 * @returns {WorkerError}
 */
export function upstreamError(status, body, what, notFoundCode = 'voice_not_found') {
  const code =
    status === 400 ? 'invalid_request_error' :
    status === 401 ? 'invalid_api_key' :
    status === 402 ? 'payment_required' :
    status === 403 ? 'permission_denied' :
    status === 404 ? notFoundCode :
    status === 429 ? 'rate_limit_exceeded' :
    'upstream_error';

  return new WorkerError(status, code, `${what}: HTTP ${status} — ${providerMessage(body)}`);
}
