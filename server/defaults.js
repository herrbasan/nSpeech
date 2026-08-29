/**
 * Server-side generation defaults — per-engine dial-ins saved from the
 * dashboard and applied to API calls that don't specify the field.
 *
 * Storage: <project>/defaults.json — { "<engine>": { voice?, speed?, extra_body? } }
 * Merge policy (speech relay): defaults fill ONLY fields the request left
 * unset. Explicit request values always win.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '..', 'defaults.json');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  if (!existsSync(FILE)) {
    _cache = {};
    return _cache;
  }
  // Corrupt file is a startup-class failure — fail loud, never silently reset.
  _cache = JSON.parse(readFileSync(FILE, 'utf8'));
  return _cache;
}

function _save() {
  writeFileSync(FILE, JSON.stringify(_cache, null, 2), 'utf8');
}

/**
 * Get defaults for an engine (or all engines when omitted).
 * Returns a shallow copy — callers must not mutate the store.
 */
export function get(engine) {
  const store = _load();
  if (engine === undefined) return { ...store };
  const d = store[engine];
  return d ? JSON.parse(JSON.stringify(d)) : null;
}

/**
 * Set defaults for an engine. Replaces the previous entry wholesale —
 * the dashboard always saves the complete dial-in.
 * Allowed shape: { voice?: string, speed?: number, extra_body?: object }
 */
export function set(engine, def) {
  if (!engine || typeof engine !== 'string') throw new Error('defaults.set: engine required');
  if (!def || typeof def !== 'object') throw new Error('defaults.set: def object required');
  const clean = {};
  if (def.voice !== undefined && def.voice !== null && def.voice !== '') clean.voice = String(def.voice);
  if (def.speed !== undefined && def.speed !== null) {
    const s = Number(def.speed);
    if (Number.isNaN(s)) throw new Error(`defaults.set: invalid speed ${JSON.stringify(def.speed)}`);
    clean.speed = s;
  }
  if (def.extra_body !== undefined && def.extra_body !== null) {
    if (typeof def.extra_body !== 'object') throw new Error('defaults.set: extra_body must be an object');
    clean.extra_body = { ...def.extra_body };
  }
  const store = _load();
  store[engine] = clean;
  _save();
  return get(engine);
}

/** Remove defaults for an engine. Returns true if an entry existed. */
export function remove(engine) {
  const store = _load();
  if (!(engine in store)) return false;
  delete store[engine];
  _save();
  return true;
}
