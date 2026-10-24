/**
 * Speaker → voice bindings for dialogue mode (the generation layer).
 *
 * The article carries **identity only** (`preset=narration:<speaker-id>`).
 * Which engine, model and voice render that identity is generation-time
 * configuration and lives here, never in the document — a voice gets retrained,
 * or the whole cast is test-rendered on a cheaper engine, without touching the
 * article (md-blocks v1.8 §5.2; nSpeech separation ruling 2026-10-23).
 *
 * Storage: <project>/dialogue-cast.json — { "<speaker-id>": entry }
 *   entry = { model? , engine?, voice_id, settings? }
 *     model     — addressable nSpeech model slug ("eleven_v4", "minimax_speech_2_8_hd")
 *     engine    — engine name instead of a slug; the provider's default model speaks
 *     voice_id  — the voice that engine speaks (clone id, native id, preset name)
 *     settings  — passed through as extra_body; `speed` is lifted to the top level
 *
 * Resolution: request `cast` override (per speaker, shallow) → registry →
 * **throw naming the unbound id**. There is no fallback voice and no default
 * engine: a silent substitution would put the wrong voice on a byline.
 *
 * A cast entry that recasts a speaker onto a different engine/model does NOT
 * inherit the registry's `settings` — those were dialled in for the old engine
 * and would leak engine-specific knobs into a different provider.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineNameFor } from './engine/manager.js';
import { WorkerError } from './engine/worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '..', 'dialogue-cast.json');

const ENTRY_KEYS = new Set(['engine', 'model', 'voice_id', 'settings']);

let _cache = null;
let _file = FILE;

/** Read + validate the registry. A broken file fails loud — never an empty cast. */
export function load() {
  if (_cache) return _cache;
  if (!existsSync(_file)) {
    _cache = {};
    return _cache;
  }
  const parsed = JSON.parse(readFileSync(_file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${_file}: expected an object of { "<speaker-id>": { ... } }`);
  }
  const out = {};
  for (const [speaker, entry] of Object.entries(parsed)) {
    out[speaker] = validateEntry(entry, `dialogue-cast.json["${speaker}"]`);
  }
  _cache = out;
  return _cache;
}

/** Validate one binding. Unknown keys are errors — a typo must not become a silent default. */
export function validateEntry(entry, where, { partial = false } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${where}: expected an object`);
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) {
      throw new Error(`${where}: unknown key \`${key}\` — allowed: ${[...ENTRY_KEYS].join(', ')}`);
    }
  }
  if (partial) {
    // A cast override may change one field (e.g. only the voice); it must not
    // be empty, or merging it would be a no-op that looks like a recast.
    if (entry.voice_id === undefined && entry.model === undefined && entry.engine === undefined) {
      throw new Error(`${where}: an override needs at least one of \`voice_id\`, \`model\`, \`engine\``);
    }
  } else {
    if (entry.model === undefined && entry.engine === undefined) {
      throw new Error(`${where}: one of \`model\` or \`engine\` is required`);
    }
  }
  if (entry.voice_id !== undefined && (typeof entry.voice_id !== 'string' || entry.voice_id === '')) {
    throw new Error(`${where}: \`voice_id\` must be a non-empty string`);
  }
  if (!partial && entry.voice_id === undefined) {
    throw new Error(`${where}: \`voice_id\` is required (a binding with no voice is not a binding)`);
  }
  for (const key of ['model', 'engine']) {
    if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key] === '')) {
      throw new Error(`${where}: \`${key}\` must be a non-empty string`);
    }
  }
  if (entry.settings !== undefined) {
    if (!entry.settings || typeof entry.settings !== 'object' || Array.isArray(entry.settings)) {
      throw new Error(`${where}: \`settings\` must be an object`);
    }
  }
  return entry;
}

/** The model selector an entry names — a slug, or a bare engine for its default model. */
function selectorOf(entry) {
  return entry.model ?? entry.engine;
}

/**
 * Resolve the binding for one speaker.
 *
 * @param {string} speaker — speaker id from the document
 * @param {Object<string, object>} [overrides] — request `cast`
 * @returns {{ model: string, engine: string, voice_id: string, settings: object, source: 'cast'|'registry' }}
 * @throws {WorkerError} 400 `dialogue_speaker_unbound` when nothing binds the id
 */
export function resolveSpeaker(speaker, overrides) {
  const registry = load();
  const base = registry[speaker];
  const override = overrides?.[speaker];
  if (override !== undefined) validateEntry(override, `cast["${speaker}"]`, { partial: true });

  if (base?.model && base?.engine && engineNameFor(base.model) !== base.engine) {
    throw new Error(`dialogue-cast.json["${speaker}"]: model "${base.model}" belongs to engine ` +
      `"${engineNameFor(base.model)}", not "${base.engine}"`);
  }
  if (override?.model && override?.engine && engineNameFor(override.model) !== override.engine) {
    throw new WorkerError(400, 'dialogue_binding_invalid',
      `cast["${speaker}"]: model "${override.model}" belongs to engine ` +
      `"${engineNameFor(override.model)}", not "${override.engine}"`);
  }

  if (!base && !override) {
    const bound = Object.keys(registry);
    throw new WorkerError(400, 'dialogue_speaker_unbound',
      `no voice binding for speaker "${speaker}" — add it to dialogue-cast.json or pass ` +
      `cast["${speaker}"]` + (bound.length ? ` (bound: ${bound.join(', ')})` : ' (the registry is empty)'));
  }

  const baseSelector = base ? selectorOf(base) : null;
  const overrideSelector = override ? selectorOf(override) : null;
  const selector = overrideSelector ?? baseSelector;

  // Settings belong to the binding they were dialled in for. A recast onto a
  // different engine/model starts from that engine's defaults instead of
  // inheriting knobs it may not even read.
  const recast = Boolean(override) && overrideSelector != null && overrideSelector !== baseSelector;
  const settings = override?.settings ?? (recast ? {} : (base?.settings ?? {}));

  return {
    model: selector,
    engine: engineNameFor(selector),
    voice_id: override?.voice_id ?? base.voice_id,
    settings: { ...settings },
    source: override ? 'cast' : 'registry',
  };
}

/** Test seam — drop the in-memory registry (used by the offline probe). */
export function _reset() {
  _cache = null;
}

/** Test seam — point the loader at another registry file, then `_reset()`. */
export function _useFile(path) {
  _file = path;
  _cache = null;
}

/** Path of the registry file, for diagnostics. */
export const registryPath = FILE;

/** Path currently in use (may be a probe's override). */
export function currentPath() {
  return _file;
}
