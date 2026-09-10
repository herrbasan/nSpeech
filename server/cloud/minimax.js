/**
 * MiniMax cloud TTS adapter.
 *
 * Implements the same streaming PCM contract as WorkerProcess so the
 * API handlers (speech.js, voices.js) don't know the difference.
 *
 * MiniMax API reference: docs/providers/minimax.md
 *
 * PCM contract: returns raw s16le 24kHz mono bytes via Node Readable.
 * Node's pipePcmToClient handles PCM→MP3/Opus/AAC transcode.
 */

import { Readable } from 'node:stream';
import { logger } from '../logger.js';
import { upstreamError } from './errors.js';
import { clampNumber } from './params.js';
import { WorkerError } from '../engine/worker.js';

const log = logger.child('cloud.minimax');

const BASE_URL = 'https://api.minimax.io';
const VOICES_CACHE_TTL_MS = 300_000; // 5 minutes

// MiniMax accepts 0.5–2.0; nSpeech's API allows 0.25–4.0. An out-of-range value
// comes back as base_resp 2013 "invalid input parameters". See cloud/params.js.
const SPEED_RANGE = { name: 'speed', min: 0.5, max: 2, provider: 'MiniMax', fallback: 1.0 };

/**
 * MiniMax reports request failures inside an **HTTP 200** body as
 * `base_resp.status_code` — so a 200 does not mean success. Codes from the T2A
 * OpenAPI spec, plus 2054 observed live ("voice id not exist"):
 *
 *   0 success · 1000 unknown · 1001 timeout · 1002 rate limit
 *   1004 authentication failed · 1039 TPM rate limit
 *   1042 invalid characters > 10% · 2013 invalid input parameters
 *   2054 voice id not exist (undocumented, observed)
 *
 * An unrecognised code is reported as a 502 upstream_error rather than guessed
 * at — the provider's own status_msg always survives in the message.
 */
const BASE_RESP_MAP = {
  1000: [502, 'upstream_error'],
  1001: [504, 'upstream_timeout'],
  1002: [429, 'rate_limit_exceeded'],
  1004: [401, 'invalid_api_key'],
  1039: [429, 'rate_limit_exceeded'],
  1042: [400, 'invalid_request_error'],
  2013: [400, 'invalid_request_error'],
  2042: [404, 'voice_not_found'],   // "you don't have access to this voice_id" (observed)
  2054: [404, 'voice_not_found'],
};

/**
 * Turn a non-zero `base_resp` into an API error, or null when the response is
 * clean. Without this the provider's reason was only logged at INFO and the
 * caller got a generic 503 "produced no audio".
 */
function baseRespError(baseResp, what) {
  const statusCode = baseResp?.status_code;
  if (!statusCode) return null;
  const [status, code] = BASE_RESP_MAP[statusCode] || [502, 'upstream_error'];
  const msg = baseResp.status_msg || `unknown status ${statusCode}`;
  return new WorkerError(status, code, `${what}: ${msg} (MiniMax status ${statusCode})`);
}

/**
 * Map our extra_body fields to MiniMax-native request params.
 * See AUDIO_API_PLAN.md §3 for the full field support matrix.
 */
function mapExtraBody(eb) {
  if (!eb || typeof eb !== 'object') return {};

  const mapped = {};

  // Voice character
  if (eb.pitch !== undefined) mapped.pitch = eb.pitch;
  if (eb.emotion) mapped.emotion = eb.emotion;
  // expressiveness — no direct MiniMax equivalent; could map to emotion or
  // voice_modify intensity
  if (eb.expressiveness !== undefined && eb.expressiveness > 0.7) {
    mapped.emotion = mapped.emotion || 'happy';
  }

  // Quality
  // inference_steps, guidance_scale — not applicable to MiniMax (cloud)

  // Text processing
  if (eb.language) mapped.language_boost = eb.language === 'auto' ? 'auto' : eb.language;
  if (eb.pronunciation) mapped.pronunciation_dict = eb.pronunciation;

  // Voice blending — per-request timbre_weights
  if (eb.blend && Array.isArray(eb.blend) && eb.blend.length > 0) {
    mapped.timbre_weights = eb.blend.map(b => ({
      voice_id: b.voice_id,
      weight: b.weight || 50,
    }));
  }

  // Audio output
  if (eb.sample_rate) mapped.sample_rate = eb.sample_rate;
  if (eb.channel) mapped.channel = eb.channel;
  if (eb.bitrate) mapped.bitrate = eb.bitrate;

  // Effects
  if (eb.sound_effects) mapped.sound_effects = eb.sound_effects;

  return mapped;
}

export class MiniMaxAdapter {
  /** Per-request char limit (API limit 10000 minus safety margin). Used by chunking. */
  get maxChars() { return 9800; }

  constructor() {
    this._apiKey = null;
    this._voicesCache = null;
    this._voicesCacheTime = 0;
  }

  /**
   * Lazy-load the API key from process.env (set by config.js from .env).
   * Fails fast if missing — no fallback, no default.
   */
  _getApiKey() {
    if (this._apiKey) return this._apiKey;

    const key = process.env.MINIMAX_API_KEY;
    if (!key) {
      throw new Error('MINIMAX_API_KEY not set in .env. Get your Subscription Key from https://platform.minimax.io/user-center/payment/token-plan');
    }
    this._apiKey = key;
    return key;
  }

  /** Always ready — no model to load. */
  health() {
    try {
      this._getApiKey();
      return { status: 'ready' };
    } catch (err) {
      return { status: 'dead', error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  generatePcmStream  —  core TTS method
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate speech and return a Readable stream of raw s16le 24kHz mono PCM.
   *
   * @param {object} params
   * @param {string} params.text
   * @param {string} params.voice_name  — MiniMax voice_id. The 'default'
   *   sentinel (and an empty value) means "provider default", NOT a voice id —
   *   forwarding it verbatim returns status 2042 "you don't have access to this
   *   voice_id".
   * @param {number} params.speed       — 0.5–2.0
   * @param {string} [params.instruct_text]  — ignored (MiniMax has no text-to-style)
   * @param {object} [params.extra_body]
   * @param {string} [params.model]     — sub-model override (speech-2.8-hd etc)
   * @returns {Promise<Readable>}
   */
  async generatePcmStream({ text, voice_name, speed, instruct_text, extra_body, model }) {
    const apiKey = this._getApiKey();
    const eb = mapExtraBody(extra_body);
    const isBatch = (extra_body?.batch) ?? false;

    const body = {
      model: model || 'speech-2.8-turbo',
      text,
      stream: !isBatch,
      output_format: 'hex',
      voice_setting: {
        // 'default' is nSpeech's "engine default" sentinel, not a MiniMax voice
        // id — sending it verbatim is rejected with 2042. Fall back to a real
        // system voice, exactly as Fish omits reference_id for the same input.
        voice_id: (voice_name && voice_name !== 'default') ? voice_name : 'English_expressive_narrator',
        speed: clampNumber(speed, SPEED_RANGE),
        vol: eb.vol ?? 1,
        pitch: eb.pitch ?? 0,
      },
      audio_setting: {
        sample_rate: eb.sample_rate ?? 24000,
        bitrate: eb.bitrate ?? 128000,
        format: 'pcm',
        channel: eb.channel ?? 1,
      },
    };

    // Streaming: skip the aggregated final chunk
    if (!isBatch) {
      body.stream_options = { exclude_aggregated_audio: true };
    }

    if (eb.emotion) body.voice_setting.emotion = eb.emotion;
    if (eb.language_boost) body.language_boost = eb.language_boost;
    if (eb.pronunciation_dict) body.pronunciation_dict = eb.pronunciation_dict;
    if (eb.timbre_weights) body.timbre_weights = eb.timbre_weights;
    if (eb.sound_effects) {
      body.voice_modify = { sound_effects: eb.sound_effects };
    }

    log.info('MiniMax generate', {
      model: body.model, batch: isBatch,
      voice: body.voice_setting.voice_id, textLen: text.length,
      textPreview: (text || '').slice(0, 200) + ((text || '').length > 200 ? '...' : ''),
    });

    const resp = await fetch(`${BASE_URL}/v1/t2a_v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.error('MiniMax T2A failed', { status: resp.status, body: errText.slice(0, 500) });
      throw upstreamError(resp.status, errText, 'MiniMax T2A failed');
    }

    // ── Batch: non-streaming, single hex blob → Buffer ───────────────────
    if (isBatch) {
      const data = await resp.json();
      log.info('MiniMax batch response', {
        status: data?.data?.status,
        baseStatus: data?.base_resp?.status_code,
        baseMsg: data?.base_resp?.status_msg,
        traceId: data?.trace_id,
        hasAudio: !!data?.data?.audio,
        audioLen: data?.data?.audio?.length,
      });
      const audio = data?.data?.audio;
      if (!audio) {
        // A 200 with no audio is almost always a base_resp error — surface the
        // provider's own reason instead of a generic "no audio".
        const baseErr = baseRespError(data?.base_resp, 'MiniMax TTS failed');
        if (baseErr) throw baseErr;
        throw new Error(
          `MiniMax batch: no audio in response (status=${data?.data?.status}, ` +
          `trace=${data?.trace_id})`
        );
      }
      const pcmBuf = Buffer.from(audio, 'hex');
      return Readable.from([pcmBuf]);
    }

    // ── Streaming: SSE hex chunks → progressive Readable ─────────────────
    // A rejected streaming request does NOT come back as SSE — MiniMax answers
    // with a plain JSON error body (content-type application/json), so the
    // error never arrives as a `data:` line and the pump below would only see
    // zero audio. Catch it here.
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const bodyText = await resp.text();
      log.error('MiniMax streaming returned a non-SSE response', {
        contentType, body: bodyText.slice(0, 300),
      });
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch { /* not JSON */ }
      const baseErr = baseRespError(parsed?.base_resp, 'MiniMax TTS failed');
      if (baseErr) throw baseErr;
      throw new Error(`MiniMax streaming: unexpected non-SSE response — ${bodyText.slice(0, 200)}`);
    }

    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buffer = '';
    let totalBytes = 0;
    let lineCount = 0;
    let emptyAudioCount = 0;

    return new Readable({
      async read() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (totalBytes === 0) {
                log.error('MiniMax streaming produced zero audio bytes', {
                  lines: lineCount,
                  emptyAudioLines: emptyAudioCount,
                });
                this.destroy(new Error('MiniMax streaming produced no audio'));
                return;
              }
              this.push(null); // EOF
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // keep incomplete line

            for (const line of lines) {
              lineCount += 1;
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) {
                if (trimmed && !trimmed.startsWith(':')) {
                  log.warn('MiniMax streaming unexpected SSE line', { line: trimmed.slice(0, 200) });
                }
                continue;
              }

              let chunk;
              try {
                chunk = JSON.parse(trimmed.slice(6));
              } catch (parseErr) {
                log.warn('MiniMax streaming unparseable SSE data line', {
                  line: trimmed.slice(0, 200),
                  error: parseErr.message,
                });
                continue;
              }

              const audio = chunk?.data?.audio;

              // An error chunk carries no audio and is reported at HTTP 200 —
              // check it before treating the chunk as empty.
              const chunkErr = baseRespError(chunk?.base_resp, 'MiniMax TTS failed');
              if (chunkErr) {
                log.error('MiniMax streaming reported an error', {
                  statusCode: chunk.base_resp.status_code,
                  statusMsg: chunk.base_resp.status_msg,
                  traceId: chunk.trace_id,
                });
                this.destroy(chunkErr);
                return;
              }

              if (audio && audio.length > 0) {
                const pcm = Buffer.from(audio, 'hex');
                totalBytes += pcm.length;
                this.push(pcm);
              } else {
                emptyAudioCount += 1;
                if (emptyAudioCount <= 5 || chunk?.data?.status === 2) {
                  log.info('MiniMax streaming empty audio chunk', {
                    status: chunk?.data?.status,
                    baseStatus: chunk?.base_resp?.status_code,
                    traceId: chunk?.trace_id,
                  });
                }
              }
            }
          }
        } catch (err) {
          this.destroy(err);
        }
      },

      destroy(err, callback) {
        reader.cancel().catch(() => {});
        callback(err);
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Voice management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List voices — returns system voices + cloned voices from MiniMax.
   * Cached for 5 minutes.
   */
  async listVoices() {
    const now = Date.now();
    if (this._voicesCache && (now - this._voicesCacheTime) < VOICES_CACHE_TTL_MS) {
      return this._voicesCache;
    }

    const apiKey = this._getApiKey();

    try {
      const resp = await fetch(`${BASE_URL}/v1/get_voice`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ voice_type: 'all' }),
      });

      if (!resp.ok) {
        log.warn('MiniMax get_voice failed', { status: resp.status });
        return { voices: [] };
      }

      const data = await resp.json();
      const voices = [];

      // System voices
      for (const v of data.system_voice || []) {
        voices.push({
          voice_id: v.voice_id,
          name: v.voice_name || v.voice_id,
          category: 'builtin',
          voice_type: 'minimax_system',
          engine: 'minimax',
          language: _guessLanguage(v.voice_id),
          description: v.description?.[0] || '',
        });
      }

      // Cloned voices — filter out transient preview voices (pv_ prefix)
      for (const v of data.voice_cloning || []) {
        if (v.voice_id && v.voice_id.startsWith('pv_')) continue;
        voices.push({
          voice_id: v.voice_id,
          name: v.voice_id,
          category: 'cloned',
          voice_type: 'minimax_cloned',
          engine: 'minimax',
          created: v.created_time,
        });
      }

      this._voicesCache = { voices };
      this._voicesCacheTime = now;

      log.info('MiniMax voices loaded', { count: voices.length });
      return this._voicesCache;
    } catch (err) {
      log.error('MiniMax voice list error', { error: err.message });
      return { voices: [] };
    }
  }

  /**
   * Clone a voice from an audio buffer.
   *
   * MiniMax cloned voices must be used in at least one T2A call before
   * they appear in GET /v1/get_voice. We do a quick generate after clone
   * to activate the voice.
   */
  async cloneVoice({ audio, voice_name, prompt_text }) {
    const apiKey = this._getApiKey();

    // MiniMax voice_id rules (official OpenAPI spec):
    //   length [8, 256] · must start with a letter · [A-Za-z0-9_-] · no
    //   trailing '-' or '_' · must not duplicate an existing voice_id.
    let cleanName = (voice_name || 'voice').replace(/[^a-zA-Z0-9]/g, '_');
    // Collapse consecutive separators
    cleanName = cleanName.replace(/_+/g, '_');
    // Remove leading underscores/digits (must start with a letter)
    cleanName = cleanName.replace(/^[_0-9]+/, '');
    // Remove trailing separators (must not end with '-' or '_')
    cleanName = cleanName.replace(/_+$/, '');
    // Empty after stripping (all-digits/punctuation name) → safe default
    if (!cleanName) cleanName = 'voice';
    // Enforce minimum length 8 by padding with letters
    while (cleanName.length < 8) cleanName += 'v';
    // Enforce maximum length 256
    if (cleanName.length > 256) cleanName = cleanName.slice(0, 256);
    // Final guard: padding must not have left a trailing separator
    cleanName = cleanName.replace(/_+$/, '');
    while (cleanName.length < 8) cleanName += 'v';

    // Step 1: Upload source audio
    const uploadForm = new FormData();
    uploadForm.append('purpose', 'voice_clone');
    uploadForm.append('file', new Blob([audio], { type: 'audio/wav' }), `${cleanName}.wav`);

    const uploadResp = await fetch(`${BASE_URL}/v1/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: uploadForm,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      throw upstreamError(uploadResp.status, errText, 'MiniMax file upload failed');
    }

    const uploadData = await uploadResp.json();
    const fileId = uploadData?.file?.file_id;
    if (!fileId) {
      throw new Error('MiniMax file upload: no file_id in response');
    }

    // Step 2: Clone
    const cloneBody = {
      file_id: fileId,
      voice_id: cleanName,
      text: 'This voice clone was created successfully.',
      model: 'speech-2.8-hd',
    };

    // prompt_text alone (without prompt_audio file_id) is rejected by MiniMax.
    // Only include clone_prompt when we have both.
    // For now, skip prompt_text — the voice description is informational only.

    const cloneResp = await fetch(`${BASE_URL}/v1/voice_clone`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cloneBody),
    });

    if (!cloneResp.ok) {
      const errText = await cloneResp.text();
      throw upstreamError(cloneResp.status, errText, 'MiniMax voice clone failed');
    }

    const cloneData = await cloneResp.json();
    const cloneErr = baseRespError(cloneData?.base_resp, 'MiniMax voice clone failed');
    if (cloneErr) throw cloneErr;

    // Step 3: Activate the voice — MiniMax requires at least one T2A
    // call before the voice appears in get_voice.
    try {
      await this.generatePcmStream({
        text: 'Voice active.',
        voice_name: cleanName,
        speed: 1.0,
      });
    } catch (err) {
      log.warn('voice activation generate failed', { voice_name: cleanName, error: err.message });
      // Non-fatal — the clone itself succeeded
    }

    // Invalidate voice cache
    this._voicesCache = null;

    return {
      voice_id: cleanName,
      name: voice_name,      // Return the original user-provided name for display
      sanitized_id: cleanName, // Show what MiniMax actually got
      category: 'cloned',
      engine: 'minimax',
    };
  }

  /**
   * Preview a cloned voice — clone + generate preview audio in one shot.
   *
   * Strategy: create with a unique timestamp-based ID first, THEN delete
   * the previous preview. This avoids MiniMax error 2039 "voice clone voice
   * id duplicate" which occurs when delete (async on MiniMax's side) hasn't
   * completed before the next clone with the same ID.
   *
   * At most 2 preview voices exist transiently (old being deleted, new
   * being created). The old one is cleaned up on the next preview cycle.
   *
   * @param {object} params
   * @param {Buffer} params.audio
   * @param {string} [params.voice_name]  — ignored (previews use generated name)
   * @param {string} [params.prompt_text]
   * @param {string} [params.preview_text] — text to speak in the preview
   * @returns {Promise<{pcmStream: Readable, extraHeaders: object}>}
   */
  async previewVoice({ audio, voice_name, prompt_text, preview_text }) {
    // Create with a unique ID first — never races with a delete.
    const newId = `pv_${Date.now()}`;

    await this.cloneVoice({ audio, voice_name: newId, prompt_text });

    // Sweep stale previews (fire-and-forget). This replaces the old
    // in-memory _lastPreviewId bookkeeping, which leaked preview voices on
    // server restart — every orphaned pv_ voice cost a clone (~$1.50) and
    // counted against MiniMax's voice store until its 7-day TTL.
    this._sweepPreviews(newId);
    this._voicesCache = null;

    // Generate preview audio
    const pcmStream = await this.generatePcmStream({
      text: preview_text || 'This is a preview of the cloned voice.',
      voice_name: newId,
      speed: 1.0,
    });

    return {
      pcmStream,
      extraHeaders: {},
    };
  }

  /**
   * Delete every transient preview voice (pv_ prefix) except the one to
   * keep. Previews are never listed to users (listVoices filters pv_), but
   * they still cost a clone each and occupy the voice store — so they must
   * be swept, not just hidden. Replaces the old in-memory _lastPreviewId
   * cleanup, which silently leaked previews across restarts.
   */
  async _sweepPreviews(keepId) {
    const apiKey = this._getApiKey();
    let previews;
    try {
      const resp = await fetch(`${BASE_URL}/v1/get_voice`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ voice_type: 'all' }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      previews = (data.voice_cloning || [])
        .map(v => v.voice_id)
        .filter(id => id && id.startsWith('pv_') && id !== keepId);
    } catch (err) {
      log.warn('preview sweep list failed', { error: err.message });
      return;
    }

    if (!previews.length) return;
    for (const id of previews) {
      this.deleteVoice(id).catch(err =>
        log.warn('preview sweep delete failed', { voice: id, error: err.message })
      );
    }
    log.info('preview sweep deleted stale previews', { count: previews.length });
  }

  /**
   * Delete a cloned voice on MiniMax.
   */
  async deleteVoice(voiceId) {
    const apiKey = this._getApiKey();

    const resp = await fetch(`${BASE_URL}/v1/delete_voice`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ voice_type: 'voice_cloning', voice_id: voiceId }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw upstreamError(resp.status, errText, 'MiniMax voice delete failed');
    }

    const data = await resp.json();
    const deleteErr = baseRespError(data?.base_resp, 'MiniMax voice delete failed');
    if (deleteErr) throw deleteErr;

    this._voicesCache = null;
    return { success: true };
  }

  /**
   * Voice mixing is not natively supported by MiniMax.
   * We could store a blend recipe and apply timbre_weights per-request,
   * but that adds complexity for a rarely-used feature. Return error.
   */
  async mixVoices() {
    throw new Error('Voice mixing is not supported on MiniMax. Use per-request "blend" in extra_body with timbre_weights instead.');
  }
}

/**
 * Guess language from MiniMax voice_id prefix.
 */
function _guessLanguage(voiceId) {
  if (!voiceId) return 'unknown';
  const id = voiceId.toLowerCase();
  if (id.includes('english')) return 'en';
  if (id.startsWith('chinese') || id.includes('(mandarin)')) return 'zh';
  if (id.startsWith('japanese')) return 'ja';
  if (id.startsWith('korean')) return 'ko';
  if (id.startsWith('spanish')) return 'es';
  if (id.startsWith('portuguese')) return 'pt';
  if (id.startsWith('french')) return 'fr';
  if (id.startsWith('german')) return 'de';
  if (id.startsWith('russian')) return 'ru';
  if (id.startsWith('italian')) return 'it';
  if (id.startsWith('indonesian')) return 'id';
  if (id.startsWith('canto')) return 'yue';
  if (id.startsWith('dutch')) return 'nl';
  if (id.startsWith('vietnamese')) return 'vi';
  if (id.startsWith('arabic')) return 'ar';
  if (id.startsWith('turkish')) return 'tr';
  if (id.startsWith('ukrainian')) return 'uk';
  if (id.startsWith('thai')) return 'th';
  if (id.startsWith('polish')) return 'pl';
  if (id.startsWith('romanian')) return 'ro';
  if (id.startsWith('greek')) return 'el';
  if (id.startsWith('czech')) return 'cs';
  if (id.startsWith('finnish')) return 'fi';
  if (id.startsWith('hindi')) return 'hi';
  return 'unknown';
}
