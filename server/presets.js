/**
 * Voice Presets — Node-managed voice configurations for all engines.
 *
 * Presets are engine-scoped JSON files stored in <project>/presets/.
 * Each file is a JSON array of preset objects. Used by cloud engines
 * (Gemini, xAI) that have system voices + instructions but no cloning,
 * and by any engine that wants to save favorite voice configurations.
 *
 * API:
 *   list(engine)      → [{id, name, voice, instructions?, speed?, extra_body?}]
 *   get(engine, id)   → preset object or null
 *   set(engine, preset) → writes JSON file, returns preset
 *   remove(engine, id) → deletes from JSON file, returns boolean
 *   resolve(engine, voiceId) → expanded {voice, instructions?, speed?, extra_body?} or null
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = resolve(__dirname, '..', 'presets');

// In-memory cache: engine → preset array. Cleared on write.
let _cache = null;

function _filePath(engine) {
  return resolve(PRESETS_DIR, `${engine}.json`);
}

function _read(engine) {
  if (_cache && _cache[engine]) return _cache[engine];

  const path = _filePath(engine);
  if (!existsSync(path)) {
    const arr = [];
    if (_cache) _cache[engine] = arr;
    return arr;
  }

  try {
    const arr = JSON.parse(readFileSync(path, 'utf8'));
    if (!_cache) _cache = {};
    _cache[engine] = arr;
    return arr;
  } catch {
    return [];
  }
}

function _write(engine, arr) {
  if (!existsSync(PRESETS_DIR)) {
    mkdirSync(PRESETS_DIR, { recursive: true });
  }
  writeFileSync(_filePath(engine), JSON.stringify(arr, null, 2), 'utf8');
  if (!_cache) _cache = {};
  _cache[engine] = arr;
}

/**
 * List all presets for an engine.
 * @param {string} engine
 * @returns {Array<{id: string, name: string, voice: string, instructions?: string, speed?: number, extra_body?: object}>}
 */
export function list(engine) {
  return _read(engine);
}

/**
 * Get a single preset by engine + id.
 * @param {string} engine
 * @param {string} id
 * @returns {object|null}
 */
export function get(engine, id) {
  const presets = _read(engine);
  return presets.find(p => p.id === id) || null;
}

/**
 * Create or update a preset.
 * @param {string} engine
 * @param {{id: string, name: string, voice: string, instructions?: string, speed?: number, extra_body?: object}} preset
 * @returns {object} the saved preset
 */
export function set(engine, preset) {
  if (!preset.id || !preset.name || !preset.voice) {
    throw new Error('Preset requires id, name, and voice fields');
  }
  const presets = _read(engine);
  const idx = presets.findIndex(p => p.id === preset.id);
  const entry = {
    id: preset.id,
    name: preset.name,
    voice: preset.voice,
    ...(preset.instructions ? { instructions: preset.instructions } : {}),
    ...(preset.speed != null ? { speed: preset.speed } : {}),
    ...(preset.extra_body ? { extra_body: preset.extra_body } : {}),
  };
  if (idx >= 0) {
    presets[idx] = entry;
  } else {
    presets.push(entry);
  }
  _write(engine, presets);
  return entry;
}

/**
 * Delete a preset.
 * @param {string} engine
 * @param {string} id
 * @returns {boolean} true if deleted, false if not found
 */
export function remove(engine, id) {
  const presets = _read(engine);
  const idx = presets.findIndex(p => p.id === id);
  if (idx < 0) return false;
  presets.splice(idx, 1);
  _write(engine, presets);
  return true;
}

/**
 * Resolve a voice ID to a preset's actual voice + instructions.
 * Returns null if the voice ID is not a preset.
 *
 * @param {string} engine — engine name (gemini, xai, etc.)
 * @param {string} voiceId — the voice ID to resolve
 * @returns {{voice: string, instructions?: string, speed?: number, extra_body?: object}|null}
 */
export function resolve(engine, voiceId) {
  const preset = get(engine, voiceId);
  if (!preset) return null;
  return {
    voice: preset.voice,
    ...(preset.instructions ? { instructions: preset.instructions } : {}),
    ...(preset.speed != null ? { speed: preset.speed } : {}),
    ...(preset.extra_body ? { extra_body: preset.extra_body } : {}),
  };
}

/**
 * Map preset objects to the GET /v1/voices response shape.
 * @param {string} engine
 * @returns {Array<{voice_id: string, name: string, voice_type: string, engine: string, base_voice: string, instructions?: string}>}
 */
export function toVoiceList(engine) {
  return list(engine).map(p => ({
    voice_id: p.id,
    name: p.name,
    voice_type: 'preset',
    engine,
    base_voice: p.voice,
    ...(p.instructions ? { instructions: p.instructions } : {}),
    ...(p.speed != null ? { speed: p.speed } : {}),
  }));
}
