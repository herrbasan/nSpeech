/**
 * nSpeech Client SDK v2 — vanilla JS client for the nSpeech V3 API.
 *
 * Works in browser and Node.js (requires global fetch). Zero dependencies.
 *
 * Improvements over v1:
 * - Event emitter for TTS lifecycle (start, ttfb, progress, complete, error)
 * - Retry with exponential backoff for network failures
 * - Typed error classes for programmatic error handling
 * - Format-aware playback (detects codec from response headers)
 * - Optional voice cache with TTL
 * - Debug logging with request IDs
 *
 * Usage:
 *   import { NSpeechClient } from './lib/nspeech-client/nspeech-client.js';
 *   const nspeech = new NSpeechClient({ baseUrl: 'http://127.0.0.1:2233', debug: true });
 *
 *   // With events
 *   const stream = nspeech.speechStream({ model: 'minimax', input: 'Hello', voice: 'English_expressive_narrator' });
 *   stream.on('ttfb', ({ timeMs }) => console.log(`TTFB: ${timeMs}ms`));
 *   stream.on('complete', ({ audioUrl }) => audio.src = audioUrl);
 *   stream.on('error', (err) => console.error(err));
 */

// ═══════════════════════════════════════════════════════════════════════════
//  Error Classes
// ═══════════════════════════════════════════════════════════════════════════

export class NSpeechError extends Error {
  constructor(message, code, status, requestId) {
    super(message);
    this.name = 'NSpeechError';
    this.code = code || 'unknown';
    this.status = status || 500;
    this.requestId = requestId || null;
  }
}

export class VoiceNotFoundError extends NSpeechError {
  constructor(voiceId, engine, requestId) {
    super(`Voice not found: ${voiceId} (engine: ${engine})`, 'voice_not_found', 404, requestId);
    this.name = 'VoiceNotFoundError';
    this.voiceId = voiceId;
    this.engine = engine;
  }
}

export class EngineError extends NSpeechError {
  constructor(message, engine, status, requestId) {
    super(message, 'engine_error', status || 503, requestId);
    this.name = 'EngineError';
    this.engine = engine;
  }
}

export class RateLimitError extends NSpeechError {
  constructor(message, retryAfter, requestId) {
    super(message, 'rate_limit_exceeded', 429, requestId);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter || 60;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Event Emitter (minimal, zero-dep)
// ═══════════════════════════════════════════════════════════════════════════

class EventEmitter {
  constructor() {
    this._events = {};
  }

  on(event, fn) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(fn);
    return this;
  }

  off(event, fn) {
    if (!this._events[event]) return this;
    this._events[event] = this._events[event].filter(f => f !== fn);
    return this;
  }

  emit(event, data) {
    if (!this._events[event]) return;
    for (const fn of this._events[event]) {
      try { fn(data); } catch (err) { console.error(`[nspeech] event handler error (${event}):`, err); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Retry Helper
// ═══════════════════════════════════════════════════════════════════════════

async function _retry(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 10000;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      // Don't retry on 4xx (client errors) — only 5xx and network failures
      if (err.status && err.status >= 400 && err.status < 500) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, maxDelay);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Voice Cache
// ═══════════════════════════════════════════════════════════════════════════

class VoiceCache {
  constructor(ttlMs = 300000) { // 5 minutes default
    this._cache = new Map();
    this._ttl = ttlMs;
  }

  get(engine) {
    const entry = this._cache.get(engine);
    if (!entry) return null;
    if (Date.now() - entry.time > this._ttl) {
      this._cache.delete(engine);
      return null;
    }
    return entry.data;
  }

  set(engine, data) {
    this._cache.set(engine, { data, time: Date.now() });
  }

  clear(engine) {
    if (engine) this._cache.delete(engine);
    else this._cache.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main Client
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl='http://127.0.0.1:2233']
 * @param {AbortSignal} [opts.signal] — default abort signal for all requests
 * @param {boolean} [opts.debug=false] — enable debug logging
 * @param {number} [opts.maxRetries=3] — max retries for network failures
 * @param {number} [opts.cacheTtl=300000] — voice cache TTL in ms (0 to disable)
 */
export class NSpeechClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:2233').replace(/\/+$/, '');
    this.signal = opts.signal || null;
    this.debug = opts.debug || false;
    this.maxRetries = opts.maxRetries ?? 3;
    this._voiceCache = opts.cacheTtl !== 0 ? new VoiceCache(opts.cacheTtl) : null;
    this._requestCounter = 0;
  }

  _log(...args) {
    if (this.debug) console.log('[nspeech]', ...args);
  }

  _requestId() {
    return `req_${Date.now()}_${++this._requestCounter}`;
  }

  // ── TTS ──────────────────────────────────────────────────────────────────

  /**
   * Generate speech. Returns the raw Response for streaming.
   *
   * @param {object} params
   * @param {string} params.model - engine model (gemini, minimax, nspeech, etc.)
   * @param {string} params.input - text to speak
   * @param {string} [params.voice='default'] - voice ID (can be a preset ID)
   * @param {string} [params.format='mp3'] - output format (mp3, opus, aac, wav, pcm, pcm_f32)
   * @param {number} [params.speed=1.0] - speaking speed
   * @param {string} [params.instructions] - style direction
   * @param {object} [params.extraBody] - engine-specific extra_body fields
   * @param {AbortSignal} [params.signal] - per-request abort signal
   * @returns {Promise<Response>}
   */
  async speech({ model, input, voice, format, speed, instructions, extraBody, signal } = {}) {
    if (!model || !input) throw new Error('model and input are required');
    const body = {
      model,
      input,
      voice: voice || 'default',
      response_format: format || 'mp3',
      speed: speed ?? 1.0,
      instructions: instructions || undefined,
      extra_body: extraBody || undefined,
    };
    if (body.instructions === undefined) delete body.instructions;
    if (body.extra_body === undefined) delete body.extra_body;

    const reqId = this._requestId();
    this._log(`[${reqId}] speech: ${model} "${input.slice(0, 50)}..." voice=${voice}`);

    return _retry(async () => {
      const res = await this._fetch('/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal || this.signal,
      }, reqId);
      this._log(`[${reqId}] speech response: ${res.status} ${res.headers.get('content-type')}`);
      return res;
    }, { maxRetries: this.maxRetries });
  }

  /**
   * Generate speech with event tracking. Returns an EventEmitter.
   *
   * Events:
   *   start    — request sent
   *   ttfb     — first byte received ({ timeMs })
   *   progress — download progress ({ bytes, totalBytes })
   *   complete — download finished ({ audioUrl, timeMs, bytes })
   *   error    — error occurred ({ error })
   *
   * @param {object} params — same as speech()
   * @returns {EventEmitter & { response: Promise<Response>, stop: function }}
   */
  speechStream(params = {}) {
    const emitter = new EventEmitter();
    const reqId = this._requestId();
    let aborted = false;

    const responsePromise = (async () => {
      const startTime = performance.now();
      emitter.emit('start', { requestId: reqId, model: params.model, inputLen: params.input?.length });

      try {
        const res = await this.speech({ ...params, signal: params.signal });
        if (aborted) return null;

        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        const reader = res.body.getReader();
        const chunks = [];
        let receivedBytes = 0;
        let firstChunk = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (aborted) {
            reader.cancel();
            return null;
          }
          if (!firstChunk && value?.length) {
            firstChunk = true;
            const ttfb = performance.now() - startTime;
            emitter.emit('ttfb', { requestId: reqId, timeMs: ttfb });
            this._log(`[${reqId}] TTFB: ${ttfb.toFixed(0)}ms`);
          }
          chunks.push(value);
          receivedBytes += value.length;
          emitter.emit('progress', { requestId: reqId, bytes: receivedBytes, totalBytes: contentLength || null });
        }

        const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(blob);
        const totalTime = performance.now() - startTime;
        emitter.emit('complete', { requestId: reqId, audioUrl, timeMs: totalTime, bytes: receivedBytes });
        this._log(`[${reqId}] complete: ${receivedBytes} bytes in ${totalTime.toFixed(0)}ms`);

        return res;
      } catch (err) {
        if (!aborted) {
          emitter.emit('error', { requestId: reqId, error: err });
          this._log(`[${reqId}] error:`, err.message);
        }
        throw err;
      }
    })();

    return Object.assign(emitter, {
      response: responsePromise,
      stop: () => { aborted = true; },
    });
  }

  // ── Voices ───────────────────────────────────────────────────────────────

  /**
   * List voices for an engine. Includes built-in, cloned, blended, and preset voices.
   * Uses cache if enabled.
   *
   * @param {string} [engine] - engine name (gemini, minimax, etc.). Defaults to current.
   * @param {AbortSignal} [signal]
   * @param {boolean} [forceRefresh=false] - bypass cache
   * @returns {Promise<{voices: Array}>}
   */
  async listVoices(engine, signal, forceRefresh = false) {
    const cacheKey = engine || '_default';
    if (!forceRefresh && this._voiceCache) {
      const cached = this._voiceCache.get(cacheKey);
      if (cached) {
        this._log(`voices cache hit: ${cacheKey}`);
        return cached;
      }
    }

    const reqId = this._requestId();
    const url = engine ? `/v1/voices?engine=${encodeURIComponent(engine)}` : '/v1/voices';
    this._log(`[${reqId}] listVoices: ${engine || 'current'}`);

    const data = await _retry(async () => {
      const res = await this._fetch(url, { signal: signal || this.signal }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    if (this._voiceCache) {
      this._voiceCache.set(cacheKey, data);
    }
    return data;
  }

  /**
   * Invalidate voice cache for an engine (or all).
   *
   * @param {string} [engine] - engine name, or omit to clear all
   */
  clearVoiceCache(engine) {
    if (this._voiceCache) {
      this._voiceCache.clear(engine);
      this._log(`voice cache cleared: ${engine || 'all'}`);
    }
  }

  /**
   * Clone a voice from reference audio. Persists the voice.
   * Invalidates voice cache on success.
   *
   * @param {object} params
   * @param {string} params.model - engine model
   * @param {string} params.name - voice name
   * @param {File|Blob} params.audio - reference audio
   * @param {string} [params.promptText] - transcript of the audio
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async cloneVoice({ model, name, audio, promptText, signal } = {}) {
    if (!model || !name || !audio) throw new Error('model, name, and audio are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] cloneVoice: ${model} "${name}"`);

    const formData = new FormData();
    formData.append('name', name);
    formData.append('audio', audio);
    if (promptText) formData.append('prompt_text', promptText);

    const result = await _retry(async () => {
      const res = await this._fetch(`/v1/voices/clone?engine=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: formData,
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(model);
    this._log(`[${reqId}] cloneVoice success: ${result.voice_id || name}`);
    return result;
  }

  /**
   * Preview a cloned voice without persisting it. Returns streaming MP3 audio.
   *
   * @param {object} params
   * @param {string} params.model - engine model
   * @param {File|Blob} params.audio - reference audio
   * @param {string} [params.testPhrase] - text to speak for preview
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Response>}
   */
  async previewVoice({ model, audio, testPhrase, signal } = {}) {
    if (!model || !audio) throw new Error('model and audio are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] previewVoice: ${model}`);

    const formData = new FormData();
    formData.append('audio', audio);
    if (testPhrase) formData.append('test_phrase', testPhrase);

    return _retry(async () => {
      return this._fetch(`/v1/voices/preview?engine=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: formData,
        signal: signal || this.signal,
      }, reqId);
    }, { maxRetries: this.maxRetries });
  }

  /**
   * Mix two voices (Kokoro only). Invalidates voice cache on success.
   *
   * @param {object} params
   * @param {string} params.name - name for the blended voice
   * @param {string} params.voiceA - first voice ID
   * @param {string} params.voiceB - second voice ID
   * @param {number} [params.ratio=0.5] - blend ratio (0 = all A, 1 = all B)
   * @param {string} [params.engine] - engine name
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async mixVoices({ name, voiceA, voiceB, ratio, engine, signal } = {}) {
    if (!name || !voiceA || !voiceB) throw new Error('name, voiceA, and voiceB are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] mixVoices: ${voiceA} + ${voiceB} -> ${name}`);

    const params = new URLSearchParams();
    if (engine) params.set('engine', engine);
    const query = params.toString();

    const result = await _retry(async () => {
      const res = await this._fetch('/v1/voices/mix' + (query ? `?${query}` : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, voice_a: voiceA, voice_b: voiceB, ratio: ratio ?? 0.5 }),
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(engine);
    this._log(`[${reqId}] mixVoices success: ${result.voice_id || name}`);
    return result;
  }

  /**
   * Delete a voice or preset. Invalidates voice cache on success.
   *
   * @param {string} engine - engine name
   * @param {string} voiceId - voice or preset ID to delete
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async deleteVoice(engine, voiceId, signal) {
    if (!engine || !voiceId) throw new Error('engine and voiceId are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] deleteVoice: ${engine} "${voiceId}"`);

    const result = await _retry(async () => {
      const res = await this._fetch(`/v1/voices/${encodeURIComponent(voiceId)}?engine=${encodeURIComponent(engine)}`, {
        method: 'DELETE',
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(engine);
    this._log(`[${reqId}] deleteVoice success`);
    return result;
  }

  // ── Presets ──────────────────────────────────────────────────────────────

  /**
   * Create or update a voice preset. Invalidates voice cache on success.
   *
   * @param {object} params
   * @param {string} params.engine - engine name
   * @param {string} params.id - unique preset ID (URL-safe slug)
   * @param {string} params.name - display name
   * @param {string} params.voice - base voice ID
   * @param {string} [params.instructions] - style instructions
   * @param {number} [params.speed] - default speed
   * @param {object} [params.extraBody] - additional extra_body fields
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async createPreset({ engine, id, name, voice, instructions, speed, extraBody, signal } = {}) {
    if (!engine || !id || !name || !voice) throw new Error('engine, id, name, and voice are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] createPreset: ${engine} "${id}" -> ${voice}`);

    const result = await _retry(async () => {
      const res = await this._fetch('/v1/voices/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, id, name, voice, instructions, speed, extra_body: extraBody }),
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(engine);
    this._log(`[${reqId}] createPreset success`);
    return result;
  }

  /**
   * Delete a preset. Invalidates voice cache on success.
   *
   * @param {string} engine - engine name
   * @param {string} id - preset ID
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async deletePreset(engine, id, signal) {
    return this.deleteVoice(engine, id, signal);
  }

  /**
   * List presets for an engine.
   *
   * @param {string} engine - engine name
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array>}
   */
  async listPresets(engine, signal) {
    const data = await this.listVoices(engine, signal);
    return (data.voices || []).filter(function(v) { return v.voice_type === 'preset'; });
  }

  // ── Engine Admin ─────────────────────────────────────────────────────────

  /**
   * Switch the active local engine.
   *
   * @param {string} engine - engine name (kokoro, dots, chatterbox-turbo, etc.)
   * @param {function} [onProgress] - callback for SSE events ({ stage, engine })
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async switchEngine(engine, onProgress, signal) {
    if (!engine) throw new Error('engine is required');
    const reqId = this._requestId();
    this._log(`[${reqId}] switchEngine: ${engine}`);

    const res = await this._fetch('/v1/admin/engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
      signal: signal || this.signal,
    }, reqId);

    if (onProgress && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onProgress(data);
              this._log(`[${reqId}] switchEngine progress: ${data.stage}`);
            } catch (_) {}
          }
        }
      }
    }
    return res.json().catch(function() { return { status: 'switched' }; });
  }

  /**
   * List all available engines.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async listEngines(signal) {
    const res = await this._fetch('/v1/admin/engines', { signal: signal || this.signal });
    return res.json();
  }

  /**
   * Get the current engine name.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async getEngine(signal) {
    const res = await this._fetch('/engine', { signal: signal || this.signal });
    const data = await res.json();
    return data.engine;
  }

  /**
   * Health check.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async getStatus(signal) {
    const res = await this._fetch('/health', { signal: signal || this.signal });
    return res.json();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  async _fetch(path, opts, reqId) {
    const url = this.baseUrl + path;
    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      let code = 'unknown';
      let voiceId = null;
      let engine = null;

      try {
        const err = await res.json();
        if (err.error) {
          detail = err.error.message || detail;
          code = err.error.code || code;
        } else if (err.message) {
          detail = err.message;
        }
        // Try to extract voice/engine info from error
        if (err.error?.param === 'voice') voiceId = path.split('/').pop();
        engine = new URLSearchParams(path.split('?')[1] || '').get('engine');
      } catch (_) {}

      // Map to typed errors
      if (res.status === 404 && code === 'voice_not_found') {
        throw new VoiceNotFoundError(voiceId || 'unknown', engine || 'unknown', reqId);
      }
      if (res.status === 429) {
        throw new RateLimitError(detail, 60, reqId);
      }
      if (res.status >= 500) {
        throw new EngineError(detail, engine || 'unknown', res.status, reqId);
      }
      throw new NSpeechError(detail, code, res.status, reqId);
    }
    return res;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Playback Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stream a speech response to a MediaSource-backed audio element.
 * Handles queue-based appending for smooth playback.
 *
 * @param {Response} response - from nspeech.speech()
 * @param {HTMLAudioElement} [audio] - existing audio element (replaced if given)
 * @param {function} [onProgress] - called with { status, timeMs, bytes }
 * @returns {Promise<{audio: HTMLAudioElement, stop: function}>}
 */
export function playSpeechStream(response, audio, onProgress) {
  var el = document.createElement('audio');
  el.controls = true;
  el.style.cssText = 'width: 100%;';
  if (audio && audio.parentNode) audio.replaceWith(el);

  var mediaSource = new MediaSource();
  el.src = URL.createObjectURL(mediaSource);
  var startTime = performance.now();
  var stopped = false;
  var totalBytes = 0;

  mediaSource.addEventListener('sourceopen', function() {
    var contentType = response.headers.get('content-type') || 'audio/mpeg';
    var mimeCodec = contentType.includes('ogg') ? 'audio/ogg; codecs=opus' :
                    contentType.includes('aac') ? 'audio/aac' : 'audio/mpeg';
    var sb;
    try {
      sb = mediaSource.addSourceBuffer(mimeCodec);
    } catch (e) {
      // Fallback to mp3 if codec not supported
      sb = mediaSource.addSourceBuffer('audio/mpeg');
    }

    var queue = [];
    var appending = false;
    var ended = false;

    function tryPlay() {
      if (!el.paused || sb.buffered.length === 0) return;
      el.play().catch(function() {});
    }

    function pumpQueue() {
      if (appending || queue.length === 0) {
        if (ended && !appending && mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
          if (onProgress) onProgress({ status: 'done', timeMs: performance.now() - startTime, bytes: totalBytes });
        }
        return;
      }
      appending = true;
      var chunk = queue.shift();
      totalBytes += chunk.length;
      sb.appendBuffer(chunk);
      sb.addEventListener('updateend', function() {
        appending = false;
        tryPlay();
        pumpQueue();
        if (onProgress) onProgress({ status: 'progress', bytes: totalBytes });
      }, { once: true });
    }

    response.body.getReader().read().then(function readLoop(result) {
      if (result.done) {
        ended = true;
        pumpQueue();
        return;
      }
      queue.push(result.value);
      pumpQueue();
      if (!stopped) result.value = null;
      return response.body.getReader().read().then(readLoop);
    }).catch(function(err) {
      if (err.name !== 'AbortError' && onProgress) {
        onProgress({ status: 'error', message: err.message });
      }
    });
  }, { once: true });

  return {
    audio: el,
    stop: function() {
      stopped = true;
      if (mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch (_) {}
      }
      el.pause();
      el.src = '';
    }
  };
}

/**
 * Download speech as a Blob (non-streaming, waits for full response).
 *
 * @param {NSpeechClient} client
 * @param {object} params - same as NSpeechClient.speech()
 * @returns {Promise<Blob>}
 */
export async function downloadSpeech(client, params) {
  var res = await client.speech(params);
  return res.blob();
}

/**
 * Download speech as an Object URL (for direct audio element src).
 *
 * @param {NSpeechClient} client
 * @param {object} params - same as NSpeechClient.speech()
 * @returns {Promise<string>} Object URL (remember to revoke with URL.revokeObjectURL)
 */
export async function downloadSpeechUrl(client, params) {
  var blob = await downloadSpeech(client, params);
  return URL.createObjectURL(blob);
}
