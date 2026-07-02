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

const log = logger.child('cloud.minimax');

const BASE_URL = 'https://api.minimax.io';
const VOICES_CACHE_TTL_MS = 300_000; // 5 minutes

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
   * @param {string} params.voice_name  — MiniMax voice_id
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
        voice_id: voice_name || 'English_expressive_narrator',
        speed: speed ?? 1.0,
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
      throw new Error(`MiniMax T2A failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
    }

    // ── Batch: non-streaming, single hex blob → Buffer ───────────────────
    if (isBatch) {
      const data = await resp.json();
      const audio = data?.data?.audio;
      if (!audio) throw new Error('MiniMax batch: no audio in response');
      const pcmBuf = Buffer.from(audio, 'hex');
      return Readable.from([pcmBuf]);
    }

    // ── Streaming: SSE hex chunks → progressive Readable ─────────────────
    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buffer = '';

    return new Readable({
      async read() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              this.push(null); // EOF
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // keep incomplete line

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;

              try {
                const chunk = JSON.parse(trimmed.slice(6));
                const audio = chunk?.data?.audio;
                if (audio && audio.length > 0) {
                  // Hex-encoded s16le PCM → raw Buffer
                  const pcm = Buffer.from(audio, 'hex');
                  this.push(pcm);
                }
              } catch {
                // Skip unparseable lines
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

      // Cloned voices
      for (const v of data.voice_cloning || []) {
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

    // MiniMax voice_id rules: alphanumeric + underscore, no leading underscore
    // or digit, no double underscores. Sanitize before sending.
    let cleanName = (voice_name || 'voice').replace(/[^a-zA-Z0-9_]/g, '_');
    // Collapse consecutive underscores
    cleanName = cleanName.replace(/_+/g, '_');
    // Remove leading underscore or digit
    cleanName = cleanName.replace(/^[_0-9]+/, '');
    // Ensure minimum length
    if (cleanName.length < 6) cleanName = cleanName + '_voice';
    // Ensure starts with a letter
    if (!/^[a-zA-Z]/.test(cleanName)) cleanName = 'v_' + cleanName;

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
      throw new Error(`MiniMax file upload failed: HTTP ${uploadResp.status} — ${errText.slice(0, 200)}`);
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
      throw new Error(`MiniMax voice clone failed: HTTP ${cloneResp.status} — ${errText.slice(0, 200)}`);
    }

    const cloneData = await cloneResp.json();
    const cloneStatus = cloneData?.base_resp?.status_code;
    if (cloneStatus !== 0) {
      throw new Error(`MiniMax voice clone error ${cloneStatus}: ${cloneData?.base_resp?.status_msg || 'unknown'}`);
    }

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
   * Returns a PCM Readable stream and optional STT transcript metadata.
   *
   * @param {object} params
   * @param {Buffer} params.audio
   * @param {string} [params.voice_name]  — generated if not provided
   * @param {string} [params.prompt_text]
   * @param {string} [params.preview_text] — text to speak in the preview
   * @returns {Promise<{pcmStream: Readable, extraHeaders: object}>}
   */
  async previewVoice({ audio, voice_name, prompt_text, preview_text }) {
    const previewName = voice_name || `tmp${Date.now()}`;

    // Clone first
    await this.cloneVoice({ audio, voice_name: previewName, prompt_text });

    // Generate preview audio
    const pcmStream = await this.generatePcmStream({
      text: preview_text || 'This is a preview of the cloned voice.',
      voice_name: previewName,
      speed: 1.0,
    });

    return {
      pcmStream,
      extraHeaders: {},
    };
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
      throw new Error(`MiniMax voice delete failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data?.base_resp?.status_code !== 0) {
      throw new Error(`MiniMax voice delete error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
    }

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
