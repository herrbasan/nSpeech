/**
 * extra_body.language — the normalized cross-engine contract.
 *
 *   extra_body.language: ISO-639-1 code ("de", "en", ...) | "auto" | omitted
 *
 *   omitted  → engine default behaviour (usually provider auto-detect)
 *   "auto"   → explicit auto-detect
 *   a code   → pin the language; each adapter converts it to the provider's
 *              native field ("however they need it" — see the map below)
 *
 * An unsupported value FAILS LOUD (400 invalid_request_error). A silently
 * ignored language is exactly how German MiniMax renders ended up reading
 * numbers in English — nobody noticed the value never reached the engine.
 *
 * Provider mapping (sources: docs/providers/*.md, grounded in official docs):
 *   minimax    → language_boost: Capitalized name or "auto"
 *   xai        → language: BCP-47 passthrough ("de", "pt-BR") or "auto"
 *   elevenlabs → language_code: ISO 639-1 passthrough; "auto" = omit
 *   gemini     → no API field (auto-detect only) — documented no-op
 *   fish       → no API field — documented no-op
 *   kokoro     → language is carried by the voice id prefix — no-op
 *   f5tts      → "de"/"en" checkpoint routing; "auto"/omitted → detect
 *   chatterbox-mtl → language_id; turbo/eng ignore it (English-only)
 */

import { WorkerError } from '../engine/worker.js';

/**
 * Validate + normalize a language value from extra_body.
 * Returns null (unset), 'auto', or the trimmed code (region tags keep their
 * case — xAI's BCP-47 wants "pt-BR", not "pt-br"). Throws on garbage.
 */
export function normalizeLanguage(value, what = 'extra_body.language') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new WorkerError(400, 'invalid_request_error',
      `${what}: must be an ISO-639-1 code or "auto", got ${typeof value}`);
  }
  const v = value.trim();
  if (!v) return null;
  if (v.toLowerCase() === 'auto') return 'auto';
  // ISO-639-1/2 primary subtag + optional BCP-47 region/variant subtags.
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v)) {
    throw new WorkerError(400, 'invalid_request_error',
      `${what}: "${value}" is not a language code (use "de", "en", "pt-BR", ... or "auto")`);
  }
  return v;
}

/**
 * ISO-639-1 → MiniMax `language_boost` value.
 * Source: MiniMax official T2A HTTP API reference (platform.minimax.io/docs/
 * api-reference/speech-t2a-http) — language_boost accepts these exact
 * capitalized names or "auto"; default null. speech-01/speech-02 series do
 * not support Persian, Filipino, Tamil.
 */
export const MINIMAX_LANGUAGE_BOOST = {
  ar: 'Arabic', af: 'Afrikaans', bg: 'Bulgarian', ca: 'Catalan',
  zh: 'Chinese', yue: 'Chinese,Yue', hr: 'Croatian', cs: 'Czech',
  da: 'Danish', nl: 'Dutch', en: 'English', fil: 'Filipino', tl: 'Filipino',
  fi: 'Finnish', fr: 'French', de: 'German', el: 'Greek', he: 'Hebrew',
  hi: 'Hindi', hu: 'Hungarian', id: 'Indonesian', it: 'Italian',
  ja: 'Japanese', ko: 'Korean', ms: 'Malay', fa: 'Persian', no: 'Norwegian',
  pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian',
  sk: 'Slovak', sl: 'Slovenian', es: 'Spanish', sv: 'Swedish', ta: 'Tamil',
  th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese',
  nn: 'Nynorsk',
};

/**
 * Normalize extra_body.language for MiniMax: null | "auto" | official name.
 * Unknown codes throw — sending an invalid language_boost would come back as
 * base_resp 2013 after the request round-trip; failing here names the cause.
 */
export function toLanguageBoost(value, what = 'extra_body.language') {
  const lang = normalizeLanguage(value, what);
  if (lang === null) return null;
  if (lang === 'auto') return 'auto';
  const boost = MINIMAX_LANGUAGE_BOOST[lang.toLowerCase()];
  if (!boost) {
    throw new WorkerError(400, 'invalid_request_error',
      `${what}: MiniMax language_boost has no "${value}" — supported: ` +
      `${Object.keys(MINIMAX_LANGUAGE_BOOST).filter(k => k !== 'tl').join(', ')}, auto`);
  }
  return boost;
}
