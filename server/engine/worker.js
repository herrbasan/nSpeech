/**
 * WorkerProcess — wraps a single Python engine worker child process.
 *
 * Responsibilities:
 *   - Spawn the worker with --port 0 (OS-assigned port).
 *   - Discover the bound port via temp file (authoritative) + stdout (fallback).
 *   - Track in-flight request count for switch/unload gating.
 *   - Detect crashes (unexpected exit) and report unhealthy.
 *   - Provide a relay() method that forwards HTTP requests to the worker,
 *     with stream stall detection and client-disconnect cancellation.
 *   - Clean shutdown: kill the process group, delete the port file.
 */
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { logger } from '../logger.js';

const log = logger.child('worker');

/** Seconds to wait for the port file to appear after spawn. */
const PORT_DISCOVERY_TIMEOUT_MS = 30_000;

/** Interval for polling the port file. */
const PORT_POLL_INTERVAL_MS = 200;

/** Seconds to wait for /health to respond after port discovery. */
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/** Default stream stall timeout (no bytes for N ms = abort). */
const DEFAULT_STREAM_TIMEOUT_MS = 30_000;

/** Seconds to wait for graceful shutdown before SIGKILL. */
const SHUTDOWN_GRACE_MS = 5_000;


export class WorkerProcess {
  /**
   * @param {string} engineName
   * @param {object} entry - Registry entry (venv_python, worker_module, gpu)
   * @param {object} opts - { srcDir: path to src/ for PYTHONPATH, projectRoot }
   */
  constructor(engineName, entry, opts = {}) {
    this.engineName = engineName;
    this.entry = entry;
    this.srcDir = opts.srcDir;
    this.projectRoot = opts.projectRoot;

    this.proc = null;
    this.port = null;
    this.baseUrl = null;
    this.portFile = null;

    this.state = 'idle';        // idle → spawning → ready → unhealthy → dead
    this.inFlight = 0;          // active request counter
    this.exitCode = null;
    this.exitSignal = null;
    this._stdoutBuffer = '';    // worker stdout (for fallback port discovery)
    this._stderrBuffer = '';    // worker stderr (for error reporting)
  }

  /**
   * Spawn the worker and wait for it to become ready.
   * Resolves with the base URL. Rejects on spawn failure or timeout.
   */
  async start() {
    if (this.state !== 'idle') {
      throw new Error(`worker ${this.engineName} already started (state=${this.state})`);
    }

    this.state = 'spawning';
    log.info(`spawning worker: ${this.engineName}`, { engine: this.engineName });

    // Generate a unique marker for the port file so we can find it.
    // The worker creates: %TEMP%/nspeech-<engine>-<pid>.port
    // We don't know the PID yet, so we scan for matching files after spawn.
    const args = [
      '-m', this.entry.worker_module,
      '--engine', this.engineName,
      '--port', '0',
      '--host', '127.0.0.1',
    ];

    const env = {
      ...process.env,
      PYTHONPATH: this.srcDir + (process.env.PYTHONPATH ? delimiter + process.env.PYTHONPATH : ''),
    };

    // Spawn in a new process group so we can kill the whole tree.
    this.proc = spawn(this.entry.venv_python, args, {
      cwd: this.projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Collect stderr for error reporting
    this.proc.stderr.on('data', (chunk) => {
      this._stderrBuffer += chunk.toString();
      if (this._stderrBuffer.length > 10_000) this._stderrBuffer = this._stderrBuffer.slice(-10_000);
    });

    // Track stdout for fallback port discovery
    this.proc.stdout.on('data', (chunk) => {
      this._stdoutBuffer += chunk.toString();
    });

    // Crash detection
    this.proc.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      if (this.state !== 'stopped') {
        this.state = 'dead';
        log.error(`worker exited unexpectedly: ${this.engineName}`, {
          engine: this.engineName,
          code, signal,
          stderr: this._stderrBuffer.slice(-2000),
        });
      }
    });

    this.proc.on('error', (err) => {
      this.state = 'dead';
      log.error(`worker spawn error: ${this.engineName}`, {
        engine: this.engineName,
        error: err.message,
      });
    });

    // Wait for the port file to appear
    try {
      await this._discoverPort();
    } catch (err) {
      this.state = 'dead';
      throw new Error(`port discovery failed for ${this.engineName}: ${err.message}`);
    }

    // Wait for /health to respond
    try {
      await this._waitForHealth();
    } catch (err) {
      this.state = 'unhealthy';
      throw new Error(`health check failed for ${this.engineName}: ${err.message}`);
    }

    this.state = 'ready';
    log.info(`worker ready: ${this.engineName} at ${this.baseUrl}`, {
      engine: this.engineName,
      port: this.port,
    });

    return this.baseUrl;
  }

  /**
   * Discover the worker's bound port by scanning for the temp file.
   * The worker writes %TEMP%/nspeech-<engine>-<pid>.port.
   */
  async _discoverPort() {
    const startTime = Date.now();
    const tempDir = tmpdir();

    while (Date.now() - startTime < PORT_DISCOVERY_TIMEOUT_MS) {
      if (this.state === 'dead') {
        throw new Error('worker died during port discovery');
      }

      // Scan for port files matching this engine
      let files;
      try {
        files = readdirSync(tempDir).filter(f => f.startsWith(`nspeech-${this.engineName}-`) && f.endsWith('.port'));
      } catch {
        files = [];
      }

      if (files.length > 0) {
        // Pick the most recently modified file (in case of stale files)
        let best = null;
        let bestMtime = 0;
        for (const f of files) {
          const fullPath = join(tempDir, f);
          const stat = statSync(fullPath);
          if (stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs;
            best = fullPath;
          }
        }

        if (best) {
          this.portFile = best;
          this.port = parseInt(readFileSync(best, 'utf8').trim(), 10);
          this.baseUrl = `http://127.0.0.1:${this.port}`;
          return;
        }
      }

      // Fallback: check stdout for NSPEECH_WORKER_PORT=
      const match = this._stdoutBuffer?.match?.(/NSPEECH_WORKER_PORT=(\d+)/);
      if (match) {
        this.port = parseInt(match[1], 10);
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        log.warn(`port discovered via stdout fallback (temp file not found): ${this.engineName}`, {
          engine: this.engineName, port: this.port,
        });
        return;
      }

      await sleep(PORT_POLL_INTERVAL_MS);
    }

    throw new Error('timed out waiting for port file');
  }

  /**
   * Poll /health until the worker responds.
   * Accepts both 'ready' and 'warming' — 'warming' means the process is up
   * but the model hasn't loaded yet. The first request will trigger the load.
   */
  async _waitForHealth() {
    const startTime = Date.now();

    while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT_MS) {
      if (this.state === 'dead') {
        throw new Error('worker died during health check');
      }

      try {
        const resp = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const body = await resp.json();
          log.info(`worker health: ${this.engineName} status=${body.status}`, {
            engine: this.engineName, status: body.status,
          });
          return;  // Process is up — accept warming or ready
        }
      } catch {
        // Not ready yet, keep polling
      }

      await sleep(500);
    }

    throw new Error('timed out waiting for health check');
  }

  /**
   * Relay an HTTP request to the worker.
   *
   * @param {string} method - HTTP method
   * @param {string} path - Path on the worker (e.g. /v1/audio/speech)
   * @param {object} opts - { headers, body, signal (client abort), streamTimeoutMs }
   * @returns {Response} - Fetch Response object (streamable)
   */
  async relay(method, path, opts = {}) {
    if (this.state !== 'ready') {
      throw new WorkerError(503, 'worker_unavailable', `Worker ${this.engineName} is ${this.state}`);
    }

    this.inFlight++;
    const streamTimeoutMs = opts.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

    // Create an abort controller that combines client disconnect + stream stall
    const controller = new AbortController();
    let stallTimer = setTimeout(() => {
      controller.abort();
      log.error(`stream stall detected: ${this.engineName}`, {
        engine: this.engineName, path, timeoutMs: streamTimeoutMs,
      });
    }, streamTimeoutMs);

    // If the caller provides a client signal, forward its abort
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(stallTimer);
        this.inFlight--;
        throw new WorkerError(499, 'client_disconnected', 'Client disconnected before request');
      }
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const url = `${this.baseUrl}${path}`;
      const fetchOpts = {
        method,
        headers: opts.headers,
        signal: controller.signal,
      };

      // Only set body + duplex when there is a body.
      // duplex:'half' is required for streaming request bodies in Node fetch.
      if (opts.body !== undefined) {
        fetchOpts.body = opts.body;
        if (typeof opts.body === 'object' && typeof opts.body.pipe === 'function') {
          fetchOpts.duplex = 'half';
        }
      }

      const resp = await fetch(url, fetchOpts);

      // For streaming audio responses, keep the stall timer running.
      // The caller is responsible for clearing it when done.
      // We attach it to the response for the caller to manage.
      if (resp.body && resp.headers.get('content-type')?.startsWith('audio/')) {
        resp._stallTimer = stallTimer;
        resp._abortController = controller;
      } else {
        // Non-streaming: clear the stall timer
        clearTimeout(stallTimer);
      }

      return resp;

    } catch (err) {
      clearTimeout(stallTimer);

      if (err.name === 'AbortError') {
        // Could be client disconnect or stall
        if (this.state === 'ready') {
          // Likely a stall — mark unhealthy
          this.state = 'unhealthy';
        }
        throw new WorkerError(503, 'stream_aborted', `Stream aborted for ${this.engineName}: ${err.message}`);
      }

      throw new WorkerError(502, 'worker_error', `Worker ${this.engineName} error: ${err.message}`);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Gracefully stop the worker.
   * Sends SIGTERM, waits SHUTDOWN_GRACE_MS, then SIGKILL.
   * Cleans up the port file.
   */
  async stop() {
    if (!this.proc) return;

    this.state = 'stopped';
    log.info(`stopping worker: ${this.engineName}`, { engine: this.engineName });

    // Clean up port file
    if (this.portFile && existsSync(this.portFile)) {
      try { unlinkSync(this.portFile); } catch { /* best-effort */ }
    }

    return new Promise((resolve) => {
      const proc = this.proc;
      let killed = false;

      const forceKill = setTimeout(() => {
        if (!killed) {
          killed = true;
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }
      }, SHUTDOWN_GRACE_MS);

      proc.on('exit', () => {
        if (!killed) {
          killed = true;
          clearTimeout(forceKill);
          resolve();
        }
      });

      // Try graceful shutdown first
      try {
        proc.kill('SIGTERM');
      } catch {
        // On Windows, SIGTERM is mapped to TerminateProcess
        killed = true;
        clearTimeout(forceKill);
        resolve();
      }
    });
  }

  /**
   * Check if the worker process is alive.
   */
  isAlive() {
    return this.proc && this.state !== 'dead' && this.state !== 'stopped' && this.exitCode === null;
  }

  /**
   * Get worker status for debugging/monitoring.
   */
  getStatus() {
    return {
      engine: this.engineName,
      state: this.state,
      port: this.port,
      baseUrl: this.baseUrl,
      inFlight: this.inFlight,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      gpu: this.entry.gpu,
    };
  }
}


// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Custom error with HTTP status code for worker failures.
 */
export class WorkerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'WorkerError';
    this.status = status;
    this.code = code;
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.status >= 500 ? 'engine_error' : 'invalid_request_error',
        code: this.code,
      },
    };
  }
}
