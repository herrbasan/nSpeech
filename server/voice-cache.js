/**
 * Voice cache — server-side, disk-persisted snapshot of every engine's voice list.
 *
 * Why this exists: a client asking for voices must never wait on a worker spawn
 * (GPU load, seconds to minutes) or a cloud round-trip. Engines and models are
 * already free — both are built from registry.json and the cloud registry with
 * no network and no worker. Voices were the only expensive surface.
 *
 * Two sources per local engine:
 *   - disk voices  — cloned/blended files in the engine's voice_dir. Readable
 *                    from the filesystem at any time; no worker, no VRAM.
 *   - built-ins    — the adapter's native catalog (Kokoro's 54). Known only to
 *                    the worker, so it comes from the last authoritative answer,
 *                    persisted to disk so it survives restarts.
 *
 * Cloud engines are refreshed from the adapter (one network call) and persisted.
 *
 * A local engine with a *resident* worker is refreshed from the worker — the
 * worker is authoritative (it merges built-ins + disk). A non-resident engine is
 * never spawned to answer a list request; the disk scan + persisted built-ins
 * stand in until the engine is next loaded.
 *
 * Mutations (clone, delete, mix, preset write) invalidate the affected engine.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from './config.js';
import { getEntry, listEngines, venvExists } from './engine/registry.js';
import { listCloudEngines, resolveCloud, cloudEngineName } from './cloud/registry.js';
import { logger } from './logger.js';

const log = logger.child('voice-cache');

const CACHE_DIR = resolve(config.projectRoot, '.cache');
const CACHE_FILE = resolve(CACHE_DIR, 'voice-cache.json');

// Cloud voice lists change only through nSpeech mutations (which invalidate),
// so a long TTL is safe; the adapter's own 5-min cache sits underneath.
const CLOUD_TTL_MS = 15 * 60 * 1000;
// Local disk scans are cheap but not free — cache briefly, invalidate on writes.
const LOCAL_TTL_MS = 30 * 1000;

const TRANSCRIPT_SIDECAR_DEFAULT = null;

/** engine → { voices: Array, at: number } */
const _memory = new Map();

/** engine → in-flight resident-warm promise (gpu:false engines only) */
const _residentWarm = new Map();

/** engine → in-flight refresh, so a stampede collapses to one fetch */
const _inFlight = new Map();

/** Whether the disk snapshot has been read (startup only — not on manual refresh) */
let _loaded = false;

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Write the whole snapshot to disk. Called after every successful refresh —
 * the file is the restart-survival layer, not an edit target.
 */
function _persist() {
  const obj = {};
  for (const [engine, entry] of _memory) {
    obj[engine] = { voices: entry.voices, at: entry.at };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Load the snapshot from disk into memory. A corrupt or unreadable file is a
 * disk boundary — tolerate it, but leave a trace and start clean rather than
 * serving a half-parsed catalog.
 */
function _load() {
  if (!existsSync(CACHE_FILE)) return;
  let obj;
  try {
    obj = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch (err) {
    log.warn('voice cache file unreadable — rebuilding from scratch', { error: err.message, file: CACHE_FILE });
    return;
  }
  let loaded = 0;
  for (const [engine, entry] of Object.entries(obj)) {
    if (!Array.isArray(entry?.voices)) continue;
    _memory.set(engine, { voices: entry.voices, at: entry.at ?? 0 });
    loaded++;
  }
  log.info('voice cache loaded from disk', { engines: loaded, file: CACHE_FILE });
}

/**
 * Read the disk snapshot once, lazily. Both the startup warm-up and the first
 * client request pass through here, so persisted native catalogs are available
 * even when a request lands before warm-up has finished. The one-shot guard
 * also keeps a manual refresh from re-reading the snapshot we just wrote.
 */
function _ensureLoaded() {
  if (_loaded) return;
  _load();
  _loaded = true;
}

// ── Filesystem scan ─────────────────────────────────────────────────────────

/** Resolve an engine's voice directory the same way the worker does. */
function _voiceDir(engineName) {
  const entry = getEntry(engineName);
  const rel = entry?.voice_dir || `venv/${engineName}/voices`;
  return resolve(config.projectRoot, rel);
}

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mirror the worker's voice directory scan (src/nspeech/worker_routes.py).
 *
 * `builtins` are merged in first and win on id collision, exactly as the worker
 * merges its native list. The per-engine quirks are real and load-bearing:
 *   - chatterbox stores a bare .wav as raw reference audio — only a matching
 *     .pt cache makes it a usable voice, so bare wavs are skipped.
 *   - f5tts needs a transcript sidecar (.f5tts.txt) beside the wav.
 *   - other engines name blend caches <name>.<engine>.pt.
 *
 * @param {string} engineName
 * @param {Array<object>} builtins — persisted native catalog (may be empty)
 * @returns {Array<object>}
 */
function _scanVoices(engineName, builtins = []) {
  const dir = _voiceDir(engineName);
  const voices = builtins.map(v => ({ ...v }));
  if (!existsSync(dir)) return voices;

  const files = readdirSync(dir);
  const names = new Set(files);
  const existing = new Set(voices.map(v => v.voice_id ?? v.name));

  const isChatterbox = engineName.startsWith('chatterbox');
  const entry = getEntry(engineName);
  const sidecar = entry?.voice_scan?.sidecar ?? TRANSCRIPT_SIDECAR_DEFAULT;

  // .wav — cloned voices (subject to the engine's usability rule)
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.wav')) continue;
    const base = f.slice(0, -4);
    if (base.startsWith('__preview__')) continue;
    if (existing.has(base)) continue;
    if (isChatterbox && !names.has(`${base}.pt`)) continue;
    if (sidecar && !names.has(`${base}${sidecar}`)) continue;
    voices.push({ voice_id: base, name: base, category: 'cloned', voice_type: 'cloned' });
    existing.add(base);
  }

  // .pt — blended / preview caches
  const ptRe = isChatterbox
    ? /\.pt$/i
    : new RegExp(`\\.${_escapeRe(engineName)}\\.pt$`, 'i');
  for (const f of files) {
    if (!ptRe.test(f)) continue;
    const base = isChatterbox ? f.slice(0, -3) : f.slice(0, -(engineName.length + 4));
    if (!base || existing.has(base)) continue;
    const preview = base.startsWith('__preview__');
    voices.push({
      voice_id: base,
      name: base,
      category: preview ? 'preview' : 'blended',
      voice_type: preview ? 'preview' : 'blended',
    });
    existing.add(base);
  }

  // .f5tts.txt — transcript sidecars whose wav is missing still name a voice
  const sc = '.f5tts.txt';
  for (const f of files) {
    if (!f.endsWith(sc)) continue;
    const base = f.slice(0, -sc.length);
    if (existing.has(base)) continue;
    voices.push({ voice_id: base, name: base, category: 'cloned', voice_type: 'cloned' });
    existing.add(base);
  }

  return voices;
}

/** Keep only the native-catalog entries — what the disk scan can't reproduce. */
function _builtinsOf(engineName) {
  const entry = _memory.get(engineName);
  if (!entry) return [];
  return entry.voices.filter(v => (v.category ?? v.voice_type) === 'builtin');
}

// ── Sources ─────────────────────────────────────────────────────────────────

function _isCloud(engineName) {
  return resolveCloud(engineName) !== null;
}

/**
 * A worker is usable only when it is already resident and healthy. Listing
 * voices must never be the thing that loads a GPU engine.
 * @returns {Promise<object|null>}
 */
async function _residentWorker(engineName) {
  const { manager } = await import('./engine/manager.js');
  const worker = manager.workers.get(engineName);
  return (worker && worker.state === 'ready') ? worker : null;
}

async function _fetchVoices(engineName) {
  if (_isCloud(engineName)) {
    const { adapter } = resolveCloud(engineName);
    const data = await adapter.listVoices();
    return data.voices || [];
  }

  const builtins = _builtinsOf(engineName);

  // A gpu:false engine is resident by design. If its warm-up is still running
  // AND we have no native catalog to serve, wait for it rather than answering
  // with a built-in-free list. With a persisted catalog we answer immediately —
  // the catalog is stable, so there is nothing to wait for.
  if (!builtins.length) {
    const pending = _residentWarm.get(engineName);
    if (pending) await pending.catch(() => {});
  }

  const worker = await _residentWorker(engineName);
  if (worker) {
    // Authoritative: the worker merges its native catalog with the disk scan.
    const data = await worker.listVoices();
    return data.voices || [];
  }

  return _scanVoices(engineName, builtins);
}

/**
 * Normalize a model string to the engine name caches are keyed by.
 * @param {string} [model] — query param as sent by the client
 * @param {string} currentEngine
 * @returns {string}
 */
export function engineKey(model, currentEngine) {
  if (!model || model === 'nspeech') return currentEngine;
  return cloudEngineName(model) || model;
}

/**
 * Whether a model string names an engine this cache can serve.
 * Internal workers (stt) are excluded — they have no voice catalog.
 */
export function isCacheable(model, currentEngine) {
  const name = engineKey(model, currentEngine);
  const entry = getEntry(name);
  if (entry && !entry.stt) return true;
  return cloudEngineName(name) !== null;
}

/** Store an authoritative voice list and persist it. */
function _store(engineName, voices) {
  _memory.set(engineName, { voices, at: Date.now() });
  _persist();
  log.info('voice cache refreshed', { engine: engineName, count: voices.length, source: _isCloud(engineName) ? 'cloud' : 'local' });
}

/**
 * Fetch fresh voices for one engine and store them. Never spawns a worker.
 * @param {string} engineName
 * @returns {Promise<{voices: Array}>}
 */
export async function refresh(engineName) {
  // Collapse concurrent refreshes of the same engine into one fetch — startup
  // warm-up and a cold client request would otherwise both hit the provider.
  const running = _inFlight.get(engineName);
  if (running) return running;

  const run = (async () => {
    const voices = await _fetchVoices(engineName);
    _store(engineName, voices);
    return { voices };
  })();
  _inFlight.set(engineName, run);
  try {
    return await run;
  } finally {
    _inFlight.delete(engineName);
  }
}

/**
 * Cached voice list for an engine.
 *
 * The request path NEVER calls an engine. A stale entry is returned as-is and
 * revalidated in the background (stale-while-revalidate), so a client waits
 * only for audio generation — never for a worker relay or a provider round-trip.
 *
 * The single exception is a cache with no entry at all, which can only happen
 * on the first request after a fresh install before warm-up has landed. Local
 * engines still resolve without a worker there (disk scan); a cloud engine has
 * no local source, so that one fetch is unavoidable.
 *
 * @param {string} engineName
 * @returns {Promise<{voices: Array}>}
 */
export async function get(engineName) {
  _ensureLoaded();
  const entry = _memory.get(engineName);

  if (entry) {
    const ttl = _isCloud(engineName) ? CLOUD_TTL_MS : LOCAL_TTL_MS;
    if ((Date.now() - entry.at) >= ttl) {
      // Revalidate off the request path. The caller gets the current snapshot.
      refresh(engineName).catch(err =>
        log.warn('background voice refresh failed', { engine: engineName, error: err.message }));
    }
    return { voices: entry.voices };
  }

  return refresh(engineName);
}

/**
 * Mutation hook — a voice was created, removed, blended or re-preset.
 *
 * Re-derives the engine's list immediately. Waiting here is correct: the cost
 * belongs to the write the caller just performed, not to some later read. The
 * alternative — marking the entry stale and serving it while refreshing in the
 * background — would be a read-your-own-write failure: the client would be
 * handed the pre-mutation list.
 *
 * @param {string} engineName
 * @returns {Promise<{voices: Array}>}
 */
export async function invalidate(engineName) {
  log.info('voice cache invalidated', { engine: engineName });
  return refresh(engineName);
}

/**
 * Diagnostic view: what is cached, how old, from where.
 */
export function status() {
  const engines = [];
  for (const [engine, entry] of _memory) {
    engines.push({
      engine,
      type: _isCloud(engine) ? 'cloud' : 'local',
      voices: entry.voices.length,
      builtins: _builtinsOf(engine).length,
      age_ms: Date.now() - entry.at,
    });
  }
  return { file: CACHE_FILE, engines };
}

// ── Startup warm-up ─────────────────────────────────────────────────────────

/**
 * Populate the cache at service start so client requests are served from
 * memory. Three passes, none of which blocks a client request:
 *
 *   1. Load the disk snapshot — instant, survives restarts.
 *   2. Rebuild every local engine from disk + snapshot built-ins — no worker.
 *   3. Refresh cloud engines and warm the always-resident CPU engines
 *      (gpu:false, e.g. Kokoro) in the background so their native catalogs
 *      are captured without a dashboard visit.
 *
 * GPU engines are deliberately not spawned — VRAM allows only one resident and
 * loading is expensive. Their disk voices are complete already (they have no
 * native catalog), so nothing is missing.
 */
export async function warm() {
  _ensureLoaded();

  for (const name of listEngines()) {
    if (getEntry(name)?.stt) continue;
    try {
      await refresh(name);
    } catch (err) {
      log.warn('local voice warm failed', { engine: name, error: err.message });
    }
  }

  // Cloud + resident-CPU warm-up run in the background: `warm()` returns as
  // soon as every local engine answers, so startup is never held hostage to a
  // provider's latency or a worker boot.
  setTimeout(() => {
    for (const c of listCloudEngines()) {
      refresh(c.name).catch(err => log.warn('cloud voice warm failed', { engine: c.name, error: err.message }));
    }
    for (const name of listEngines()) {
      const entry = getEntry(name);
      if (!entry || entry.gpu || entry.stt || !venvExists(name)) continue;
      _warmResident(name);
    }
  }, 0);
}

/**
 * Spawn an always-resident CPU engine so its native catalog lands in the cache.
 * Failure is logged, never fatal — a broken venv must not stop the server.
 */
async function _warmResident(engineName) {
  const run = (async () => {
    const { manager } = await import('./engine/manager.js');
    const worker = await manager.getWorker(engineName);
    // Read the worker directly — do NOT go through refresh(). _fetchVoices
    // awaits this very promise when no native catalog is cached yet, so
    // calling refresh() from inside it is a self-deadlock: the promise would
    // await itself and never settle, silently leaving Kokoro's built-ins
    // uncaptured forever.
    const data = await worker.listVoices();
    const voices = data.voices || [];
    _store(engineName, voices);
    log.info('resident engine warmed', { engine: engineName, count: voices.length });
  })();
  _residentWarm.set(engineName, run);
  try {
    await run;
  } catch (err) {
    // A broken CPU venv must not stop the server — the disk scan still answers.
    log.warn('resident engine warm failed', { engine: engineName, error: err.message });
  } finally {
    _residentWarm.delete(engineName);
  }
}
