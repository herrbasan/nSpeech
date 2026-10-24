/**
 * EngineManager — manages the lifecycle of engine worker processes.
 *
 * Responsibilities:
 *   - Lazy-start workers on first request.
 *   - Enforce GPU exclusion: only one GPU engine resident at a time.
 *   - Serialize engine switches through a mutex.
 *   - Track in-flight requests per worker for switch/unload gating.
 *   - Sweep stale worker processes on startup.
 *   - Kill all workers on shutdown (process group).
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { getEntry, listEngines, venvExists, PROJECT_ROOT } from './registry.js';
import { WorkerProcess, WorkerError } from './worker.js';
import { resolveCloud, cloudEngineName } from '../cloud/registry.js';
import { logger } from '../logger.js';
import { emit } from '../events.js';

const log = logger.child('manager');

/** Every engine name a client could legitimately ask for, for error messages. */
function availableEngineNames() {
  // listEngines() already returns names.
  return [...listEngines(), 'minimax', 'elevenlabs', 'gemini', 'xai', 'fish'];
}

const SRC_DIR = resolve(PROJECT_ROOT, 'src');
const ENGINE_STATE_FILE = resolve(PROJECT_ROOT, '.engine_state.json');


export class EngineManager {
  constructor() {
    /** @type {Map<string, WorkerProcess>} */
    this.workers = new Map();

    /** Current default engine (used for voice management endpoints). */
    this.currentEngine = null;
    // Voice listing may address api_hidden engines by name (dashboard pages
    // list voices from their own engine). Generation may not — see getEngine.
    this._allowHiddenLookup = false;

    /** Mutex for serialized engine switching. */
    this._switchLock = Promise.resolve();
  }

  /**
   * Initialize: set the current engine from persisted state or config default,
   * then sweep stale state. Does NOT spawn any workers — lazy loading only.
   */
  init(defaultEngine) {
    const state = this._loadState();
    this.currentEngine = state.engine ?? defaultEngine;
    // Two different questions, deliberately two fields:
    //   currentEngine — what the dashboard is working with (which local engine
    //                   is resident, which pages the sidebar offers).
    //   defaultEngine — what a client gets when it sends `model: "nspeech"`
    //                   (or nothing). Reported by /health.
    // They used to be one value, so selecting a cloud engine in the dashboard
    // silently became the default for every client. An older state file has
    // only `engine`; that engine is what clients WERE getting, so it seeds the
    // default rather than resetting to the config value.
    this.defaultEngine = state.defaultEngine ?? this.currentEngine;
    WorkerProcess.sweepStalePortFiles();
    log.info('engine manager initialized', {
      configDefault: defaultEngine,
      currentEngine: this.currentEngine,
      defaultEngine: this.defaultEngine,
    });
    emit('system', `Engine manager initialized — dashboard: ${this.currentEngine}, client default: ${this.defaultEngine}`, {
      defaultEngine: this.defaultEngine, currentEngine: this.currentEngine,
    });
  }

  /**
   * Read `.engine_state.json`. Missing/corrupt state falls back to the config
   * default (both fields) — that is a boot-time boundary, logged, never silent.
   */
  _loadState() {
    try {
      if (existsSync(ENGINE_STATE_FILE)) {
        const parsed = JSON.parse(readFileSync(ENGINE_STATE_FILE, 'utf8'));
        const state = {};
        if (parsed?.engine && this._isValidEngine(parsed.engine)) state.engine = parsed.engine;
        if (parsed?.defaultEngine && this._isValidEngine(parsed.defaultEngine)) state.defaultEngine = parsed.defaultEngine;
        return state;
      }
    } catch (err) {
      log.warn('failed to load persisted engine state', { error: err.message });
    }
    return {};
  }

  /**
   * Update the engine the DASHBOARD is working with (and, for a local engine,
   * the resident one) and persist it. Does not touch the client default.
   */
  setCurrentEngine(engineName) {
    this.currentEngine = engineName;
    this._persistState();
  }

  /**
   * Set the engine clients get for `model: "nspeech"` / omitted. Explicit on
   * purpose: no request path changes it, so a cloud test cannot steal it.
   *
   * @param {string} engineName — local engine name or cloud provider name
   * @returns {{engine: string, previous: string|null}}
   */
  setDefaultEngine(engineName) {
    if (!this._isValidEngine(engineName)) {
      throw new WorkerError(404, 'engine_not_found',
        `Unknown engine: ${engineName}. Available: ${availableEngineNames().join(', ')}`);
    }
    const previous = this.defaultEngine;
    this.defaultEngine = engineName;
    this._persistState();
    log.info('client default engine set', { engine: engineName, previous });
    emit('engine', `Client default engine: ${engineName}`, { engine: engineName, previous });
    return { engine: engineName, previous };
  }

  /** Persist both pointers so a restart restores the same split. */
  _persistState() {
    try {
      writeFileSync(ENGINE_STATE_FILE, JSON.stringify({
        engine: this.currentEngine,
        defaultEngine: this.defaultEngine,
      }, null, 2));
    } catch (err) {
      log.warn('failed to persist engine state', { error: err.message });
    }
  }

  /**
   * Check whether a string names a known local engine or cloud provider.
   */
  _isValidEngine(engineName) {
    if (getEntry(engineName)) return true;
    return resolveCloud(engineName) !== null;
  }

  /**
   * Resolve an engine from a model string — checks cloud first, then local.
   *
   * Accepted values:
   *   - "nspeech" (or null/empty) → routes to the dashboard-selected local engine
   *   - cloud prefixes ("minimax", "elevenlabs", "gemini", "xai") → cloud adapter
   *   - local engine names ("kokoro", "chatterbox-turbo", etc.) →
   *     resolves to that engine's worker (lazy-started via getWorker)
   *
   * The dashboard's per-engine pages use local engine names directly to
   * target a specific engine regardless of the current dashboard selection.
   *
   * Returns { engine, model } where:
   *   engine: object implementing generatePcmStream, listVoices, cloneVoice, etc.
   *   model:  provider sub-model resolved from the model string (cloud only).
   *
   * For local engines, model is null.
   *
   * @param {string} model — model selector ("nspeech", "minimax", "kokoro", etc.)
   * @returns {Promise<{engine: WorkerProcess|CloudAdapter, model: string|null}>}
   */
  async getEngine(model) {
    // ── Normalize: null/undefined/empty/"nspeech" → the CLIENT DEFAULT ─────
    // Not the dashboard selection: a cloud test in the UI must never change
    // what an API client gets. See defaultEngine in init().
    const resolved = (!model || model === 'nspeech') ? this.defaultEngine : model;

    // ── Cloud providers — check model prefix ─────────────────────────────
    const cloud = resolveCloud(resolved);
    if (cloud) {
      return { engine: cloud.adapter, model: cloud.model };
    }

    // ── Local engines — resolve to worker (lazy-started) ────────────────
    // The dashboard's per-engine pages target specific local engines by
    // name (kokoro, chatterbox-turbo, etc.). getWorker() handles venv checks,
    // lazy spawning, and GPU exclusion.
    const entry = getEntry(resolved);
    if (entry) {
      // Dashboard-only engines (api_hidden) are not API-addressable by name
      // for GENERATION — the bilingual f5tts covers both languages. They stay
      // fully usable via the dashboard (engine switch makes them current, and
      // their pages address them by name), including voice listing.
      if (entry.api_hidden && resolved !== this.currentEngine && !this._allowHiddenLookup) {
        throw new WorkerError(404, 'engine_not_found',
          `Model "${resolved}" is dashboard-only. Use "f5tts" (bilingual EN/DE) instead.`);
      }
      const worker = await this.getWorker(resolved);
      return { engine: worker, model: null };
    }

    // ── Unknown engine ───────────────────────────────────────────────────
    throw new WorkerError(404, 'engine_not_found',
      `Unknown model: "${resolved}". Available: nspeech, minimax, elevenlabs, gemini, xai, fish.`);
  }

  /**
   * Get or start a worker for the given engine.
   * If the engine is GPU and another GPU engine is loaded, unload it first.
   *
   * @param {string} engineName
   * @returns {Promise<WorkerProcess>}
   */
  async getWorker(engineName) {
    const entry = getEntry(engineName);
    if (!entry) {
      throw new WorkerError(404, 'engine_not_found', `Unknown engine: ${engineName}`);
    }

    if (!venvExists(engineName)) {
      throw new WorkerError(503, 'venv_missing', `Venv not found for engine: ${engineName}`);
    }

    // Check if already loaded and healthy
    const existing = this.workers.get(engineName);
    if (existing) {
      if (existing.state === 'ready') {
        return existing;
      }
      if (existing.state === 'dead' || existing.state === 'unhealthy') {
        // Worker died — stop its process (free VRAM!) then respawn
        log.warn(`removing dead worker: ${engineName}`, { engine: engineName, state: existing.state });
        emit('worker', `Removing dead worker: ${engineName} (state: ${existing.state})`, { engine: engineName, state: existing.state });
        await existing.stop().catch(() => {});
        this.workers.delete(engineName);
      } else {
        // Still spawning/warming — wait for it. `whenReady` rejects if the
        // spawn dies; on success return the ready worker.
        await existing.whenReady();
        return existing;
      }
    }

    // GPU exclusion: unload other GPU engines before spawning
    if (entry.gpu) {
      await this._unloadOtherGpuEngines(engineName);
    }

    // Spawn the worker
    const worker = new WorkerProcess(engineName, entry, { srcDir: SRC_DIR, projectRoot: PROJECT_ROOT });
    this.workers.set(engineName, worker);

    try {
      await worker.start();
    } catch (err) {
      this.workers.delete(engineName);
      throw new WorkerError(503, 'engine_start_failed', `Failed to start ${engineName}: ${err.message}`);
    }

    return worker;
  }

  /**
   * Get the currently active worker (for voice management endpoints
   * that don't specify an engine).
   * @returns {Promise<WorkerProcess>}
   */
  async getCurrentWorker() {
    return this.getWorker(this.currentEngine);
  }

  /**
   * Switch the active engine. Serialized through a mutex.
   *
   * @param {string} engineName
   * @param {object} callbacks - { onStatus(stage, engine) } for SSE progress
   * @returns {Promise<object>} - { engine, status }
   */
  async switchEngine(engineName, callbacks = {}) {
    const entry = getEntry(engineName);
    // A cloud provider is a valid selection: it has no worker, so "switching"
    // to it only moves the dashboard's context (see _doSwitch). Treating it as
    // unknown here is what made a cloud engine unreachable from the switcher.
    if (!entry && !resolveCloud(engineName)) {
      throw new WorkerError(404, 'engine_not_found', `Unknown engine: ${engineName}`);
    }

    // Serialize: chain onto the switch lock
    return this._switchLock = this._switchLock.then(async () => {
      return this._doSwitch(engineName, callbacks);
    });
  }

  async _doSwitch(engineName, callbacks) {
    const { onStatus } = callbacks;

    // ── Cloud selection is a CONTEXT change, not a residency change ──────
    // A cloud provider has no worker: there is nothing to unload and nothing
    // to spawn. (The API route handles this before reaching here; this is the
    // boundary that keeps an SDK calling switchEngine('minimax') from trying
    // to start a local worker named "minimax".)
    if (!getEntry(engineName) && resolveCloud(engineName)) {
      this.setCurrentEngine(engineName);
      emit('engine', `Selected cloud engine ${engineName}`, { engine: engineName });
      return { engine: engineName, status: 'cloud_selected' };
    }

    // Already active?
    if (this.currentEngine === engineName) {
      const worker = this.workers.get(engineName);
      if (worker && worker.state === 'ready') {
        return { engine: engineName, status: 'already_active' };
      }
    }

    // Check in-flight requests on the current engine
    const currentWorker = this.workers.get(this.currentEngine);
    if (currentWorker && currentWorker.inFlight > 0) {
      throw new WorkerError(409, 'engine_busy',
        `Cannot switch: ${currentWorker.inFlight} request(s) active on ${this.currentEngine}`);
    }

    const entry = getEntry(engineName);

    // ── Unload the current engine (GPU only) ─────────────────────────────
    // Resident (non-GPU) engines like Kokoro hold no VRAM and stay loaded
    // across switches — they remain callable like a cloud provider. Only
    // GPU engines are unloaded here to free VRAM before loading the new
    // model. (Cloud providers never appear in this.workers at all.)
    const oldEngineName = this.currentEngine;
    const oldWorker = this.workers.get(oldEngineName);
    const oldEntry = getEntry(oldEngineName);
    if (oldWorker && oldEntry && oldEntry.gpu) {
      if (onStatus) onStatus('unload_start', oldEngineName);
      if (oldWorker.state === 'ready') {
        await oldWorker.stop();
      } else {
        // Dead / unhealthy / spawning worker: never wait on it — a wedged
        // respawn would block every subsequent switch. Kill without waiting
        // for the graceful VRAM-free handshake (there's nothing to free
        // cleanly anyway) and drop it from the map.
        log.warn(`dropping non-ready worker on switch: ${oldEngineName}`, {
          engine: oldEngineName, state: oldWorker.state,
        });
        emit('engine', `Dropping ${oldEngineName} worker (state: ${oldWorker.state})`, {
          engine: oldEngineName, state: oldWorker.state,
        });
        oldWorker.stop().catch(() => {}); // fire-and-forget
      }
      this.workers.delete(oldEngineName);
      if (onStatus) onStatus('unload_done', oldEngineName);
    }

    // Also unload any other GPU engines that might be loaded.
    // GPU exclusion is about COEXISTENCE: only one GPU engine at a time.
    // _unloadOtherGpuEngines catches stragglers that shouldn't exist but
    // might due to stale state.
    await this._unloadOtherGpuEngines(engineName);

    // Spawn the new engine
    if (onStatus) onStatus('load_start', engineName);
    const worker = await this.getWorker(engineName);
    if (onStatus) onStatus('load_done', engineName);

    this.setCurrentEngine(engineName);
    log.info(`engine switched: ${engineName}`, { engine: engineName });
    emit('engine', `Switched to ${engineName}`, { engine: engineName });

    return { engine: engineName, status: 'switched' };
  }

  /**
   * Unload a specific engine's worker.
   */
  async unload(engineName) {
    const worker = this.workers.get(engineName);
    if (!worker) return;

    if (worker.inFlight > 0) {
      throw new WorkerError(409, 'engine_busy',
        `Cannot unload: ${worker.inFlight} request(s) active on ${engineName}`);
    }

    await worker.stop();
    this.workers.delete(engineName);
    log.info(`engine unloaded: ${engineName}`, { engine: engineName });
    emit('engine', `Unloaded ${engineName}`, { engine: engineName });
  }

  /**
   * Make an engine the client default AND converge residency onto it.
   *
   * The pointer moves immediately (clients get the new engine from the next
   * request); the worker work runs in the background, because a cold GPU
   * engine takes ~30s and a checkbox must not hang on it:
   *
   *   local engine  → a real switch: unload the previous GPU engine, spawn this one
   *   cloud engine  → nothing to load; free any GPU engine that is no longer needed
   *
   * gpu:false residents (Kokoro) are never unloaded — they cost no VRAM.
   *
   * @param {string} engineName
   * @returns {{engine: string, previous: string|null, converging: boolean}}
   */
  promoteDefaultEngine(engineName) {
    const pointer = this.setDefaultEngine(engineName); // validates
    const local = getEntry(engineName);

    const converge = local
      ? this.switchEngine(engineName)
      : this._unloadOtherGpuEngines(null).then(() => this.setCurrentEngine(engineName));

    converge.catch((err) => {
      // The pointer stands; the engine simply is not warm. Say so loudly —
      // the dashboard shows this on the event stream.
      log.error('default engine residency convergence failed', {
        engine: engineName, error: err.message, code: err.code ?? null,
      });
      emit('error', `Default set to ${engineName}, but loading it failed: ${err.message}`, {
        engine: engineName, code: err.code ?? null,
      });
    });

    return { ...pointer, converging: true };
  }

  /**
   * Unload all GPU engines except the specified one.
   */
  async _unloadOtherGpuEngines(keepEngine) {
    const toUnload = [];
    for (const [name, worker] of this.workers) {
      if (name !== keepEngine && worker.entry.gpu && worker.state !== 'stopped') {
        toUnload.push(name);
      }
    }

    for (const name of toUnload) {
      log.info(`unloading GPU engine for exclusion: ${name}`, { engine: name });
      emit('engine', `GPU exclusion: unloading ${name}`, { engine: name });
      const worker = this.workers.get(name);
      // 'ready' workers only — a dead/spawning one is dropped, not awaited.
      if (worker.state === 'ready') {
        await worker.stop();
      } else {
        worker.stop().catch(() => {});
      }
      this.workers.delete(name);
    }
  }

  /**
   * Get status of all workers (for monitoring/debugging).
   */
  getStatus() {
    const workers = {};
    for (const [name, worker] of this.workers) {
      workers[name] = worker.getStatus();
    }
    return {
      currentEngine: this.currentEngine,
      defaultEngine: this.defaultEngine,
      workers,
    };
  }

  /**
   * Shutdown all workers. Called on Node server shutdown.
   */
  async shutdownAll() {
    log.info('shutting down all workers');
    emit('system', 'Shutting down all workers');
    const stops = [];
    for (const [name, worker] of this.workers) {
      stops.push(worker.stop().catch(err => {
        log.error(`error stopping ${name}`, { engine: name, error: err.message });
      }));
    }
    await Promise.all(stops);
    this.workers.clear();
    log.info('all workers stopped');
    emit('system', 'All workers stopped');
  }
}

// Singleton instance
export const manager = new EngineManager();

/**
 * Canonical engine name for a `model` string — the key that engine-scoped
 * stores (generation defaults, voice presets) are keyed by.
 *
 * A client may legitimately send `"nspeech"` (the documented value for the
 * current local engine), a cloud model slug (`"minimax_speech_2_8_hd"`), a
 * legacy alias, or a bare engine name. Only the last of those matches a stored
 * key, so looking the stores up by the raw `model` string silently missed
 * every other form — a saved dial-in then appeared "not to persist" while the
 * engine fell back to its own hardwired defaults.
 *
 * Unknown strings pass through unchanged, so they simply match nothing.
 *
 * @param {string} [model]
 * @returns {string|null}
 */
export function engineNameFor(model) {
  if (!model || model === 'nspeech') return manager.defaultEngine;
  return cloudEngineName(model) || model;
}
