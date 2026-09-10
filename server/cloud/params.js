/**
 * Provider parameter normalisation — the numeric bounds a provider enforces
 * that nSpeech's own API does not.
 *
 * nSpeech accepts `speed` 0.25–4.0, but the cloud providers each enforce a
 * narrower range and hard-reject anything outside it (HTTP 400, or an in-body
 * status). Passing that rejection straight through surfaced as a 503 that read
 * as an outage, so we clamp at the boundary and leave a trace instead.
 *
 * Current provider ranges:
 *   xAI       0.7 – 1.5
 *   MiniMax   0.5 – 2.0
 *   Fish      0.5 – 2.0
 *   ElevenLabs 0.7 – 1.2 (clamped in the adapter)
 */
import { logger } from '../logger.js';

const log = logger.child('cloud.params');

/**
 * Clamp a numeric parameter into a provider's supported range.
 *
 * @param {number|undefined|null} value — the requested value
 * @param {object} opts
 * @param {string} opts.name       — parameter name, e.g. 'speed'
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {string} opts.provider   — provider label for the log line
 * @param {number} opts.fallback   — used when the caller left it unset
 * @returns {number}
 */
export function clampNumber(value, { name, min, max, provider, fallback }) {
  const requested = value ?? fallback;
  if (!Number.isFinite(requested)) {
    throw new Error(
      `clampNumber(${provider} ${name}): value is not a finite number ` +
      `(got ${value}, fallback ${fallback})`
    );
  }
  if (requested >= min && requested <= max) return requested;

  const clamped = Math.min(Math.max(requested, min), max);
  log.warn(`${provider} ${name} clamped to provider range`, {
    provider, param: name, requested, clamped, min, max,
  });
  return clamped;
}
