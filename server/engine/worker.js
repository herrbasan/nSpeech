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
import * as readline from 'node:readline/promises';
import { readFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

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

    // Build the worker env. Per-engine voice/model dirs override whatever the
    // Node parent process inherited — otherwise a hot-swap to a different engine
    // would launch the new engine with the old engine's NSPEECH_MODEL_DIR,
    // causing the Python config to look in the wrong venv and 503 on first
    // request. See src/nspeech/config.py for the required env vars.
    const engineVoiceDir = resolve(
      this.projectRoot,
      `venv/${this.engineName}/voices`
    );
    const engineModelDir = resolve(
      this.projectRoot,
      `venv/${this.engineName}/models`
    );

    const env = {
      ...process.env,
      NSPEECH_ENGINE: this.engineName,
      NSPEECH_VOICE_DIR: engineVoiceDir,
      NSPEECH_MODEL_DIR: engineModelDir,
      PYTHONPATH: this.srcDir + (process.env.PYTHONPATH ? delimiter + process.env.PYTHONPATH : ''),
    };

    // Spawn in a new process group so we can kill the whole tree.
    this.proc = spawn(this.entry.venv_python, args, {
      cwd: this.projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // ── Forward worker logs into the unified combined log ───────────────────
    // The worker emits nLogger-format JSONL on stdout (its own logger) plus
    // engine-internal noise on stderr (loguru/torch/onnx). We read both
    // line-by-line and fan every line into logs/main-0.log via the unified
    // logger, tagged with the engine. This is the single disk write — the
    // worker itself writes no log files — so every engine's output lands in
    // one stream, attributable and greppable.
    this._attachLogForwarding();

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
   * Forward the worker's stdout/stderr into the unified combined log.
   *
   * stdout carries nLogger JSONL lines from the worker's own logger, plus the
   * two NSPEECH_WORKER_PORT= discovery lines. stderr carries engine-internal
   * output (loguru, torch, onnxruntime) as plain text.
   *
   * Each JSONL stdout line is re-emitted through the unified logger with its
   * original level/type, tagged with this engine. Plain lines (stderr, or
   * non-JSON stdout) are wrapped as engine.<name>.<stream> entries. The
   * stdout buffer is still kept for fallback port discovery (strategy 3),
   * and a trimmed stderr buffer for crash dumps.
   */
  _attachLogForwarding() {
    const engine = this.engineName;
    const engineType = `engine.${engine}`;

    // stdout: discovery lines + JSONL worker logs
    const stdoutRl = readline.createInterface({ input: this.proc.stdout });
    stdoutRl.on('line', (line) => {
      this._stdoutBuffer += line + '\n';

      // Discovery markers — not log lines.
      if (line.startsWith('NSPEECH_WORKER_PORT')) return;

      const parsed = this._tryParseLogLine(line);
      if (parsed) {
        this._forwardLog(parsed.level, parsed.type, parsed.msg, { ...parsed.meta, engine });
      } else {
        // Non-JSON stdout (unexpected, but capture it).
        this._forwardLog('INFO', `${engineType}.stdout`, line, { engine });
      }
    });

    // stderr: engine noise (loguru/torch/onnx). Wrap each line.
    const stderrRl = readline.createInterface({ input: this.proc.stderr });
    stderrRl.on('line', (line) => {
      this._stderrBuffer += line + '\n';
      if (this._stderrBuffer.length > 10_000) {
        this._stderrBuffer = this._stderrBuffer.slice(-10_000);
      }
      const trimmed = line.trim();
      if (trimmed) {
        this._forwardLog('WARN', `${engineType}.stderr`, trimmed, { engine });
      }
    });
  }

  _tryParseLogLine(line) {
    if (!line || line[0] !== '{') return null;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof obj !== 'object' || obj === null) return null;
    if (typeof obj.msg !== 'string') return null;
    const level = String(obj.level || 'INFO').toUpperCase();
    return {
      level: ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level) ? level : 'INFO',
      type: typeof obj.type === 'string' && obj.type ? obj.type : `engine.${this.engineName}`,
      msg: obj.msg,
      meta: (obj.meta && typeof obj.meta === 'object') ? obj.meta : {},
    };
  }

  _forwardLog(level, type, msg, meta) {
    switch (level) {
      case 'ERROR':
        logger.error(msg, meta, type);
        break;
      case 'WARN':
        logger.warn(msg, meta, type);
        break;
      case 'DEBUG':
        logger.debug(msg, meta, type);
        break;
      default:
        logger.info(msg, meta, type);
    }
  }

  /**
   * Discover the worker's bound port by scanning for the temp file.
   * The worker writes %TEMP%/nspeech-<engine>-<pid>.port.
   *
   * On Windows, the spawned Python process may have a different OS PID than
   * the one Node sees (uvicorn/torch subprocesses), so we can't rely on
   * PID-matching. Instead we scan for ANY nspeech-<engine>-*.port file.
   * This is safe because GPU exclusion ensures only one worker per engine
   * runs at a time, and CPU engines (kokoro) don't conflict.
   *
   * Stale port files from crashed workers are swept at startup (see sweep()).
   * We also validate the port by checking stdout as a cross-reference.
   */
  async _discoverPort() {
    const startTime = Date.now();
    const tempDir = tmpdir();
    const spawnedPid = this.proc.pid;
    const expectedFileName = `nspeech-${this.engineName}-${spawnedPid}.port`;

    log.info(`discovering port for worker pid ${spawnedPid}, engine ${this.engineName}`);

    while (Date.now() - startTime < PORT_DISCOVERY_TIMEOUT_MS) {
      if (this.state === 'dead') {
        throw new Error('worker died during port discovery');
      }

      // Strategy 1: exact PID match (works when the spawned PID == writer PID)
      const exactPath = join(tempDir, expectedFileName);
      if (existsSync(exactPath)) {
        const port = this._tryReadPortFile(exactPath);
        if (port !== null) {
          log.info(`discovered port via exact PID file: ${this.engineName} on port ${port}`);
          return;
        }
      }

      // Strategy 2: scan for any nspeech-<engine>-*.port file.
      // The worker may write with a child PID (Windows uvicorn/torch fork).
      const scanned = this._scanForPortFile(tempDir);
      if (scanned) {
        log.info(`discovered port via engine scan: ${this.engineName} on port ${scanned.port} (file PID mismatch: spawned=${spawnedPid})`, {
          engine: this.engineName, port: scanned.port, file: scanned.file,
        });
        return;
      }

      // Strategy 3: stdout fallback (last resort — fragile but functional)
      const match = this._stdoutBuffer?.match?.(/NSPEECH_WORKER_PORT=(\d+)/);
      if (match) {
        this.port = parseInt(match[1], 10);
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        log.warn(`port discovered via stdout fallback (no port file found): ${this.engineName}`, {
          engine: this.engineName, port: this.port,
        });
        return;
      }

      await sleep(PORT_POLL_INTERVAL_MS);
    }

    throw new Error('timed out waiting for port file');
  }

  /**
   * Try to read a port number from a port file.
   * Returns the port number or null if the file is empty/invalid.
   * Sets this.port, this.portFile, this.baseUrl on success.
   */
  _tryReadPortFile(filePath) {
    try {
      const content = readFileSync(filePath, 'utf8').trim();
      if (content) {
        const port = parseInt(content, 10);
        if (port > 0 && port < 65536) {
          this.port = port;
          this.portFile = filePath;
          this.baseUrl = `http://127.0.0.1:${port}`;
          return port;
        }
      }
    } catch (err) {
      log.warn(`error reading port file ${filePath}: ${err.message}`);
    }
    return null;
  }

  /**
   * Scan the temp directory for any nspeech-<engine>-*.port file.
   * Returns { port, file } or null if none found.
   * Sets this.port, this.portFile, this.baseUrl on success.
   */
  _scanForPortFile(tempDir) {
    const prefix = `nspeech-${this.engineName}-`;
    const suffix = '.port';
    let entries;
    try {
      entries = readdirSync(tempDir);
    } catch {
      return null;
    }

    // Only consider files modified recently (within the last 60 seconds).
    // Stale port files from crashed workers must be ignored — otherwise we
    // connect to a dead port while the actual current worker tries to bind
    // to a different port and we never find it.
    const maxAgeMs = 60_000;
    const now = Date.now();

    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const filePath = join(tempDir, name);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) continue;
      } catch {
        continue;
      }
      const port = this._tryReadPortFile(filePath);
      if (port !== null) {
        return { port, file: filePath };
      }
    }
    return null;
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
      } catch (err) {
        log.warn(`health check poll failed for ${this.engineName}: ${err.message} on url ${this.baseUrl} with cause: ${err.cause ? err.cause.message || err.cause : 'none'}`);
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

  /**
   * Sweep stale port files from the temp directory.
   * Called at startup to clean up files left by crashed workers.
   * Only removes files matching nspeech-<engine>-<pid>.port that are
   * older than 5 minutes (to avoid racing with a concurrent startup).
   */
  static sweepStalePortFiles() {
    const tempDir = tmpdir();
    const maxAgeMs = 5 * 60 * 1000;  // 5 minutes
    const now = Date.now();
    let swept = 0;

    let entries;
    try {
      entries = readdirSync(tempDir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (!name.startsWith('nspeech-') || !name.endsWith('.port')) continue;
      const filePath = join(tempDir, name);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
          swept++;
        }
      } catch {
        // file may have been removed between readdir and stat — ignore
      }
    }

    if (swept > 0) {
      log.info(`swept ${swept} stale port file(s) from temp dir`);
    }
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
