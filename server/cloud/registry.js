/**
 * Cloud engine registry — maps model prefixes to cloud adapters.
 *
 * Each cloud provider is a native Node module under server/cloud/.
 * No Python venv, no child process, no GPU. They implement the same
 * streaming PCM contract as WorkerProcess so the API handlers don't
 * know the difference.
 *
 * Registry format:
 *   prefix → { adapter, name, models }
 *
 * Model prefix examples:
 *   "minimax" → matches "minimax", "minimax_speech_2_8_hd", etc.
 *   "openai_tts" → matches "openai_tts_1", "openai_tts_1_hd"
 */

import { MiniMaxAdapter } from './minimax.js';
import { ElevenLabsAdapter } from './elevenlabs.js';
import { XaiAdapter } from './xai.js';
import { GeminiAdapter } from './gemini.js';
import { logger } from '../logger.js';

const log = logger.child('cloud');

/** @type {Map<string, {adapter, models: string[]}>} */
const _adapters = new Map();

/**
 * Register a cloud adapter for a model prefix.
 */
function _register(prefix, AdapterClass, models) {
  const adapter = new AdapterClass();
  _adapters.set(prefix, { adapter, models });
  log.info('cloud adapter registered', { prefix, models });
}

// ── Register known providers ────────────────────────────────────────────────

_register('minimax', MiniMaxAdapter, [
  'minimax_speech_2_8_turbo',
  'minimax_speech_2_8_hd',
  'minimax_speech_2_6_hd',
  'minimax_speech_2_6_turbo',
]);

_register('elevenlabs', ElevenLabsAdapter, [
  'eleven_turbo_v2_5',
  'elevenlabs_turbo_v2',
  'elevenlabs_turbo_v2_5',
  'elevenlabs_multilingual_v2',
  'elevenlabs_flash_v2_5',
]);

_register('xai', XaiAdapter, [
  'xai_grok_tts_1',
  'xai_grok_tts_1_hd',
]);

_register('gemini', GeminiAdapter, [
  'gemini-3.1-flash-tts-preview',
  'gemini_3_1_flash_tts_preview',
  'gemini_3_1_flash_tts',
]);

/**
 * Convert a public model slug suffix into the provider's native model name.
 * Handles version numbers (e.g. 2_8 → 2.8, 3_1 → 3.1) and underscores → hyphens.
 */
function normalizeSubModel(prefix, suffix) {
  // Version numbers use dots: speech_2_8_hd → speech-2.8-hd
  let normalized = suffix.replace(/(\d)_(\d)/g, '$1.$2');

  // Remaining underscores become hyphens
  normalized = normalized.replace(/_/g, '-');

  // Provider-specific prefixes that survive normalization
  if (prefix === 'gemini') {
    // gemini_3_1_flash_tts_preview → gemini-3.1-flash-tts-preview
    normalized = `gemini-${normalized}`;
  } else if (prefix === 'elevenlabs') {
    // elevenlabs_turbo_v2_5 → eleven-turbo-v2.5
    normalized = `eleven-${normalized}`;
  } else if (prefix === 'xai') {
    // xai_grok_tts_1 → grok-tts-1 (xai models omit the xai- prefix)
    normalized = normalized.replace(/^grok-tts-/, 'grok-tts-');
  }

  return normalized;
}

/**
 * Resolve a model string to a cloud adapter (if it matches).
 * Returns { adapter, model } or null.
 *
 * Model strings can be:
 *   "minimax" → MiniMax adapter, model="speech-2.8-turbo" (default)
 *   "minimax_speech_2_8_hd" → MiniMax adapter, model="speech-2.8-hd"
 *   "kokoro" → null (not a cloud model)
 */
export function resolveCloud(model) {
  if (!model || typeof model !== 'string') return null;

  // Try exact prefix match first, then startsWith
  for (const [prefix, entry] of _adapters) {
    if (model === prefix) {
      // Bare prefix: use the first real model, never the prefix itself.
      const defaultSlug = entry.models.find(m => m !== prefix) || entry.models[0];
      // The default slug may still be in public form (e.g. minimax_speech_2_8_turbo).
      // Convert it to the provider-native model ID (e.g. speech-2.8-turbo).
      const defaultModel = defaultSlug.startsWith(prefix + '_')
        ? normalizeSubModel(prefix, defaultSlug.slice(prefix.length + 1))
        : defaultSlug;
      return { adapter: entry.adapter, model: defaultModel };
    }
    if (model.startsWith(prefix + '_')) {
      const suffix = model.slice(prefix.length + 1);
      return { adapter: entry.adapter, model: normalizeSubModel(prefix, suffix) };
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
 * Get all registered cloud engines for the admin endpoint.
 */
export function listCloudEngines() {
  const result = [];
  for (const [prefix, entry] of _adapters) {
    result.push({
      name: prefix,
      type: 'cloud',
      models: entry.models,
      health: entry.adapter.health(),
    });
  }
  return result;
}
