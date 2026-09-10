/**
 * Cloud engine registry — maps model prefixes to cloud adapters.
 *
 * Each cloud provider is a native Node module under server/cloud/.
 * No Python venv, no child process, no GPU. They implement the same
 * streaming PCM contract as WorkerProcess so the API handlers don't
 * know the difference.
 *
 * Registry format:
 *   prefix → { adapter, models, aliases }
 *
 * Model prefix examples:
 *   "minimax" → matches "minimax" (default), "minimax_speech_2_8_hd", etc.
 *   "openai_tts" → matches "openai_tts_1", "openai_tts_1_hd"
 */

import { MiniMaxAdapter } from './minimax.js';
import { ElevenLabsAdapter } from './elevenlabs.js';
import { XaiAdapter } from './xai.js';
import { GeminiAdapter } from './gemini.js';
import { FishAdapter } from './fish.js';
import { logger } from '../logger.js';

const log = logger.child('cloud');

/**
 * Registry of cloud engine model catalogs.
 *
 * Each provider's `models` array is the authoritative list of addressable
 * models. Every entry carries:
 *   - `id`       — public slug the client sends as `model` (listed in /v1/models)
 *   - `provider` — native model name passed to the provider API
 *   - `label`    — display name for the dashboard / docs
 *   - `default`  — marks the provider's default; a bare engine prefix aliases to it
 *
 * `aliases` maps extra accepted model ids (legacy/documented forms) to a
 * canonical `id`. Aliases resolve to the same provider model but are not
 * listed separately in /v1/models.
 */
const _adapters = new Map();

/**
 * Register a cloud adapter for a model prefix.
 * @param {string} prefix  — engine id, e.g. "minimax"
 * @param {*} AdapterClass — adapter constructor
 * @param {Array<{id: string, provider: string, label: string, default?: boolean}>} models
 * @param {Object<string,string>} [aliases] — extra accepted model ids → canonical id
 */
function _register(prefix, AdapterClass, models, aliases = {}) {
  const adapter = new AdapterClass();
  _adapters.set(prefix, { adapter, models, aliases });
  log.info('cloud adapter registered', { prefix, models: models.map(m => m.id) });
}

// ── Register known providers ────────────────────────────────────────────────

_register('minimax', MiniMaxAdapter, [
  { id: 'minimax_speech_2_8_turbo', provider: 'speech-2.8-turbo', label: 'MiniMax Speech 2.8 Turbo', default: true },
  { id: 'minimax_speech_2_8_hd',    provider: 'speech-2.8-hd',    label: 'MiniMax Speech 2.8 HD' },
  { id: 'minimax_speech_2_6_hd',    provider: 'speech-2.6-hd',    label: 'MiniMax Speech 2.6 HD' },
  { id: 'minimax_speech_2_6_turbo', provider: 'speech-2.6-turbo', label: 'MiniMax Speech 2.6 Turbo' },
]);

_register('elevenlabs', ElevenLabsAdapter, [
  { id: 'eleven_v3',              provider: 'eleven_v3',              label: 'Eleven v3', default: true },
  { id: 'eleven_multilingual_v2', provider: 'eleven_multilingual_v2', label: 'Eleven Multilingual v2' },
  { id: 'eleven_flash_v2_5',      provider: 'eleven_flash_v2_5',      label: 'Eleven Flash v2.5' },
  { id: 'eleven_flash_v2',        provider: 'eleven_flash_v2',        label: 'Eleven Flash v2 (English)' },
  { id: 'eleven_turbo_v2_5',      provider: 'eleven_turbo_v2_5',      label: 'Eleven Turbo v2.5 (deprecated)' },
  { id: 'eleven_turbo_v2',        provider: 'eleven_turbo_v2',        label: 'Eleven Turbo v2 (deprecated)' },
], {
  // Legacy prefixed slugs (documented / older clients) → canonical id.
  'elevenlabs_turbo_v2_5':      'eleven_turbo_v2_5',
  'elevenlabs_multilingual_v2': 'eleven_multilingual_v2',
  'elevenlabs_flash_v2_5':      'eleven_flash_v2_5',
  'elevenlabs_flash_v2':        'eleven_flash_v2',
  'elevenlabs_turbo_v2':        'eleven_turbo_v2',
});

_register('xai', XaiAdapter, [
  { id: 'xai', provider: 'tts', label: 'Grok Voice (TTS)', default: true },
], {
  // xAI's TTS endpoint has NO model parameter — one endpoint, selected only by
  // voice. The two slugs we used to advertise were never real models; the
  // adapter never sent them, so choosing between them did nothing.
  // Kept as aliases so stored client values still resolve.
  'xai_grok_tts_1': 'xai',
  'xai_grok_tts_1_hd': 'xai',
});

_register('gemini', GeminiAdapter, [
  { id: 'gemini-3.1-flash-tts-preview', provider: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS (preview)', default: true },
], {
  // There is no non-preview gemini-3.1-flash-tts — Google answers 404
  // "Model not found" (verified 2026-09-10). It was never a second model, just
  // an inert selector entry. Kept as an alias so stored values still resolve.
  'gemini_3_1_flash_tts': 'gemini-3.1-flash-tts-preview',
  'gemini_3_1_flash_tts_preview': 'gemini-3.1-flash-tts-preview',
});

_register('fish', FishAdapter, [
  { id: 'fish_s2_1_pro_free', provider: 's2.1-pro-free', label: 'Fish S2.1 Pro (free)', default: true },
  { id: 'fish_s2_1_pro',      provider: 's2.1-pro',      label: 'Fish S2.1 Pro (paid)' },
  { id: 'fish_s2_pro',        provider: 's2-pro',        label: 'Fish S2 Pro' },
  { id: 'fish_s1',            provider: 's1',            label: 'Fish S1' },
]);

/**
 * Resolve a model string to a cloud adapter (if it matches).
 * Returns { adapter, model } or null.
 *
 * Model strings can be:
 *   "minimax"                     → MiniMax adapter, its default model
 *   "minimax_speech_2_8_hd"       → MiniMax adapter, model="speech-2.8-hd"
 *   "elevenlabs_turbo_v2_5"       → ElevenLabs adapter, model="eleven_turbo_v2_5" (legacy alias)
 *   "kokoro"                      → null (not a cloud model)
 */
export function resolveCloud(model) {
  if (!model || typeof model !== 'string') return null;

  // Bare engine prefix → the provider's default model.
  if (_adapters.has(model)) {
    const entry = _adapters.get(model);
    const dflt = entry.models.find(m => m.default) || entry.models[0];
    return { adapter: entry.adapter, model: dflt.provider };
  }

  // Exact model id, or a documented alias resolving to a canonical id.
  for (const [, entry] of _adapters) {
    const exact = entry.models.find(m => m.id === model);
    if (exact) return { adapter: entry.adapter, model: exact.provider };

    const aliasTarget = entry.aliases?.[model];
    if (aliasTarget) {
      const target = entry.models.find(m => m.id === aliasTarget);
      if (target) return { adapter: entry.adapter, model: target.provider };
    }
  }

  return null;
}

/**
 * Check if a model string belongs to any cloud provider.
 */
export function isCloudModel(model) {
  return resolveCloud(model) !== null;
}

/**
 * The engine (registry prefix) a model string belongs to, or null.
 *
 * "minimax" and "minimax_speech_2_8_hd" both → "minimax"; legacy aliases
 * ("elevenlabs_turbo_v2_5") → "elevenlabs". Used to key engine-scoped caches
 * by a canonical name regardless of which addressable slug the caller sent.
 */
export function cloudEngineName(model) {
  if (!model || typeof model !== 'string') return null;
  if (_adapters.has(model)) return model;
  for (const [prefix, entry] of _adapters) {
    if (entry.models.some(m => m.id === model)) return prefix;
    if (entry.aliases?.[model]) return prefix;
  }
  return null;
}

/**
 * Get all registered cloud engines for the admin / models endpoints.
 *
 * Each engine exposes its model catalog: `models` is an array of
 * `{ id, provider, label, default }` (the addressable public slugs), and
 * `defaultModel` is the canonical id of the provider's default.
 */
export function listCloudEngines() {
  const result = [];
  for (const [prefix, entry] of _adapters) {
    const models = entry.models.map(m => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
      default: !!m.default,
    }));
    result.push({
      name: prefix,
      type: 'cloud',
      models,
      defaultModel: (entry.models.find(m => m.default) || entry.models[0]).id,
      health: entry.adapter.health(),
    });
  }
  return result;
}
