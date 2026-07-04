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
import { resolveCloud } from '../cloud/registry.js';
import { logger } from '../logger.js';

const log = logger.child('manager');

const SRC_DIR = resolve(PROJECT_ROOT, 'src');
const ENGINE_STATE_FILE = resolve(PROJECT_ROOT, '.engine_state.json');


export class EngineManager {
  constructor() {
    /** @type {Map<string, WorkerProcess>} */
    this.workers = new Map();

    /** Current default engine (used for voice management endpoints). */
    this.currentEngine = null;

    /** Mutex for serialized engine switching. */
    this._switchLock = Promise.resolve();
  }

  /**
   * Initialize: set the current engine from persisted state or config default,
   * then sweep stale state. Does NOT spawn any workers — lazy loading only.
   */
  init(defaultEngine) {
    this.currentEngine = this._loadPersistedEngine(defaultEngine);
    WorkerProcess.sweepStalePortFiles();
    log.info('engine manager initialized', { defaultEngine, currentEngine: this.currentEngine });
  }

  /**
   * Load the last-selected engine from disk, falling back to the configured
   * default if the persisted value is missing or invalid.
   */
  _loadPersistedEngine(fallback) {
    try {
      if (existsSync(ENGINE_STATE_FILE)) {
        const raw = readFileSync(ENGINE_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.engine && this._isValidEngine(parsed.engine)) {
          return parsed.engine;
        }
      }
    } catch (err) {
      log.warn('failed to load persisted engine state', { error: err.message });
    }
    return fallback;
  }

  /**
   * Update the current engine and persist it to disk.
   */
  setCurrentEngine(engineName) {
    this.currentEngine = engineName;
    this._persistCurrentEngine();
  }

  /**
   * Persist the currently selected engine to disk so it survives restarts.
   */
  _persistCurrentEngine() {
    try {
      writeFileSync(ENGINE_STATE_FILE, JSON.stringify({ engine: this.currentEngine }, null, 2));
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
   * Returns { engine, model } where:
   *   engine: object implementing generatePcmStream, listVoices, cloneVoice, etc.
   *   model:  provider sub-model resolved from the model string (cloud only).
   *
   * For local engines, model is null.
   *
   * @param {string} model — model selector (e.g. "minimax", "kokoro", "cosyvoice_0.5b")
   * @returns {Promise<{engine: WorkerProcess|CloudAdapter, model: string|null}>}
   */
  async getEngine(model) {
    const engineName = model || this.currentEngine;

    // ── Cloud providers — check both model prefix AND bare engine name ─────
    const cloud = resolveCloud(engineName);
    if (cloud) {
      return { engine: cloud.adapter, model: cloud.model };
    }

    // ── Local engines ─────────────────────────────────────────────────────
    return { engine: await this.getWorker(engineName), model: null };
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
        // Worker died — remove and respawn
        log.warn(`removing dead worker: ${engineName}`, { engine: engineName, state: existing.state });
        this.workers.delete(engineName);
      } else {
        // Still spawning — wait for it
        throw new WorkerError(503, 'engine_starting', `Engine ${engineName} is still starting`);
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
    if (!entry) {
      throw new WorkerError(404, 'engine_not_found', `Unknown engine: ${engineName}`);
    }

    // Serialize: chain onto the switch lock
    return this._switchLock = this._switchLock.then(async () => {
      return this._doSwitch(engineName, callbacks);
    });
  }

  async _doSwitch(engineName, callbacks) {
    const { onStatus } = callbacks;

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

    // Unload current GPU engine if switching to a different GPU engine
    if (entry.gpu && this.currentEngine !== engineName) {
      const oldWorker = this.workers.get(this.currentEngine);
      if (oldWorker && oldWorker.entry.gpu) {
        if (onStatus) onStatus('unload_start', this.currentEngine);
        await oldWorker.stop();
        this.workers.delete(this.currentEngine);
        if (onStatus) onStatus('unload_done', this.currentEngine);
      }
    }

    // Also unload any other GPU engines that might be loaded
    await this._unloadOtherGpuEngines(engineName);

    // Spawn the new engine
    if (onStatus) onStatus('load_start', engineName);
    const worker = await this.getWorker(engineName);
    if (onStatus) onStatus('load_done', engineName);

    this.setCurrentEngine(engineName);
    log.info(`engine switched: ${engineName}`, { engine: engineName });

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
  }

  /**
   * Unload all GPU engines except the specified one.
   */
  async _unloadOtherGpuEngines(keepEngine) {
    const toUnload = [];
    for (const [name, worker] of this.workers) {
      if (name !== keepEngine && worker.entry.gpu && worker.state === 'ready') {
        toUnload.push(name);
      }
    }

    for (const name of toUnload) {
      log.info(`unloading GPU engine for exclusion: ${name}`, { engine: name });
      const worker = this.workers.get(name);
      await worker.stop();
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
      workers,
    };
  }

  /**
   * Shutdown all workers. Called on Node server shutdown.
   */
  async shutdownAll() {
    log.info('shutting down all workers');
    const stops = [];
    for (const [name, worker] of this.workers) {
      stops.push(worker.stop().catch(err => {
        log.error(`error stopping ${name}`, { engine: name, error: err.message });
      }));
    }
    await Promise.all(stops);
    this.workers.clear();
    log.info('all workers stopped');
  }
}

// Singleton instance
export const manager = new EngineManager();
