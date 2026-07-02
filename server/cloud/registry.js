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
  'minimax',
  'minimax_speech_2_8_hd',
  'minimax_speech_2_8_turbo',
  'minimax_speech_2_6_hd',
  'minimax_speech_2_6_turbo',
]);

_register('elevenlabs', ElevenLabsAdapter, [
  'elevenlabs',
  'elevenlabs_turbo_v2',
  'elevenlabs_turbo_v2_5',
  'elevenlabs_multilingual_v2',
  'elevenlabs_flash_v2_5',
]);

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
      return { adapter: entry.adapter, model: entry.models[0] }; // default model
    }
    if (model.startsWith(prefix + '_')) {
      // Convert minimax_speech_2_8_hd → speech-2.8-hd
      const subModel = model.slice(prefix.length + 1);
      return { adapter: entry.adapter, model: subModel };
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
