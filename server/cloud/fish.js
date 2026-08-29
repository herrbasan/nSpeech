/**
 * Fish Audio cloud TTS adapter (S2 / S2.1 family).
 *
 * API: POST https://api.fish.audio/v1/tts
 *  - JSON body (msgpack only needed for inline binary references — we use reference_id)
 *  - Model selected via the `model` HEADER: s2.1-pro | s2.1-pro-free | s2-pro | s1
 *  - PCM output: 16-bit mono, 8k/16k/24k/32k/44.1k sample rates
 *  - Response is chunked — progressive streaming works on the stream path
 *
 * Docs: https://docs.fish.audio/features/text-to-speech
 *
 * PCM contract: returns raw s16le 24kHz mono bytes via Node Readable.
 * Node's pipePcmToClient handles PCM→MP3/Opus/AAC transcode.
 */

import { Readable } from 'node:stream';
import { logger } from '../logger.js';

const log = logger.child('cloud.fish');

const BASE_URL = 'https://api.fish.audio';
const VOICES_CACHE_TTL_MS = 300_000; // 5 minutes

/** Map our extra_body fields to Fish-native request params. */
function mapExtraBody(eb) {
  if (!eb || typeof eb !== 'object') return {};
  const m = {};
  if (eb.temperature !== undefined) m.temperature = eb.temperature;
  if (eb.top_p !== undefined) m.top_p = eb.top_p;
  if (eb.repetition_penalty !== undefined) m.repetition_penalty = eb.repetition_penalty;
  if (eb.latency !== undefined) m.latency = eb.latency; // 'normal' | 'balanced' | 'low'
  if (eb.chunk_length !== undefined) m.chunk_length = eb.chunk_length; // 100-300
  if (eb.normalize !== undefined) m.normalize = eb.normalize;
  if (eb.volume !== undefined) m.volume = eb.volume; // dB, prosody
  return m;
}

export class FishAdapter {
  /**
   * Per-request char limit. Fish chunks long text internally (chunk_length
   * ≤300 chars) with no documented hard text limit; we cap conservatively
   * so nSpeech chunking + progress events keep working for long-form.
   */
  get maxChars() { return 8000; }

  constructor() {
    this._apiKey = null;
    this._voicesCache = null;
    this._voicesCacheTime = 0;
  }

  _getApiKey() {
    if (this._apiKey) return this._apiKey;
    const key = process.env.FISH_AUDIO_API_KEY;
    if (!key) throw new Error('FISH_AUDIO_API_KEY not set in .env. Get your key from https://fish.audio/app/api-keys/');
    this._apiKey = key;
    return key;
  }

  health() {
    try { this._getApiKey(); return { status: 'ready' }; }
    catch (err) { return { status: 'dead', error: err.message }; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  generatePcmStream
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * @param {object} params
   * @param {string} params.text
   * @param {string} params.voice_name  — Fish voice model id (reference_id)
   * @param {number} params.speed       — 0.5–2.0 (1.0 = normal)
   * @param {string} [params.instruct_text] — ignored; S2 uses [bracket] tags in text
   * @param {object} [params.extra_body]
   * @param {string} [params.model]     — s2.1-pro | s2.1-pro-free | s2-pro | s1
   */
  async generatePcmStream({ text, voice_name, speed, instruct_text, extra_body, model }) {
    const apiKey = this._getApiKey();
    const eb = mapExtraBody(extra_body);
    const isBatch = (extra_body?.batch) ?? false;

    const body = {
      text,
      format: 'pcm',
      sample_rate: 24000,
      prosody: {
        speed: speed ?? 1.0,
        normalize_loudness: true,
      },
    };
    if (eb.volume !== undefined) body.prosody.volume = eb.volume;
    // 'default'/empty means Fish's built-in default voice — omit reference_id entirely.
    if (voice_name && voice_name !== 'default') body.reference_id = voice_name;
    if (eb.temperature !== undefined) body.temperature = eb.temperature;
    if (eb.top_p !== undefined) body.top_p = eb.top_p;
    if (eb.repetition_penalty !== undefined) body.repetition_penalty = eb.repetition_penalty;
    if (eb.latency !== undefined) body.latency = eb.latency;
    if (eb.chunk_length !== undefined) body.chunk_length = eb.chunk_length;
    if (eb.normalize !== undefined) body.normalize = eb.normalize;

    log.info('Fish generate', {
      model: model || 's2.1-pro-free', voice: voice_name || '(default)',
      textLen: text.length, batch: isBatch,
      textPreview: (text || '').slice(0, 200) + ((text || '').length > 200 ? '...' : ''),
    });

    const resp = await fetch(`${BASE_URL}/v1/tts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'model': model || 's2.1-pro-free',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.error('Fish TTS failed', { status: resp.status, body: errText.slice(0, 500) });
      throw new Error(`Fish TTS failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
    }

    if (isBatch) {
      const pcmBuf = Buffer.from(await resp.arrayBuffer());
      log.info('Fish batch PCM', { bytes: pcmBuf.length });
      return Readable.from([pcmBuf]);
    }

    // Streaming: response is chunked raw PCM — pipe through progressively.
    const reader = resp.body.getReader();
    return new Readable({
      async read() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { this.push(null); return; }
            this.push(Buffer.from(value));
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

  // ═══════════════════════════════════════════════════════════════════════
  //  Voice management
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * List voices — the caller's own voice models (GET /model?self=true).
   * Cached for 5 minutes. Fish has no fixed "builtin" voice set in the API;
   * without a reference_id the service uses its default voice.
   */
  async listVoices() {
    const now = Date.now();
    if (this._voicesCache && (now - this._voicesCacheTime) < VOICES_CACHE_TTL_MS) {
      return this._voicesCache;
    }

    const apiKey = this._getApiKey();

    try {
      const resp = await fetch(`${BASE_URL}/model?self=true&page_size=100`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!resp.ok) {
        log.warn('Fish voice list failed', { status: resp.status });
        return { voices: [] };
      }

      const data = await resp.json();
      const voices = [];

      for (const v of data.items || []) {
        voices.push({
          voice_id: v._id,
          name: v.title || v._id,
          category: 'cloned',
          voice_type: 'fish_cloned',
          engine: 'fish',
          description: v.description || '',
          labels: v.tags || {},
        });
      }

      this._voicesCache = { voices };
      this._voicesCacheTime = now;

      log.info('Fish voices loaded', { count: voices.length });
      return this._voicesCache;
    } catch (err) {
      log.error('Fish voice list error', { error: err.message });
      return { voices: [] };
    }
  }

  /**
   * Clone a voice — POST /model multipart form (type=tts, train_mode=fast).
   * `train_mode: fast` returns a usable model almost immediately (state=trained).
   */
  async cloneVoice({ audio, voice_name, prompt_text }) {
    const apiKey = this._getApiKey();

    const form = new FormData();
    form.append('type', 'tts');
    form.append('title', voice_name);
    form.append('visibility', 'private');
    form.append('train_mode', 'fast');
    form.append('voices', new Blob([audio], { type: 'audio/wav' }), `${voice_name}.wav`);
    if (prompt_text) form.append('texts', prompt_text);

    const resp = await fetch(`${BASE_URL}/model`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let detail = errText;
      try {
        const errJson = JSON.parse(errText);
        detail = errJson.message || errText;
      } catch {}
      log.error('Fish clone failed', { status: resp.status, body: errText.slice(0, 300) });
      throw new Error(`Fish clone failed: HTTP ${resp.status} — ${detail.slice(0, 200)}`);
    }

    const data = await resp.json();
    this._voicesCache = null;

    if (data.state === 'failed') {
      throw new Error(`Fish clone training failed for "${voice_name}"`);
    }

    return {
      voice_id: data._id,
      name: voice_name,
      category: 'cloned',
      engine: 'fish',
    };
  }

  /**
   * Preview: clone a throwaway voice, generate the preview, then delete the
   * clone so previews don't clutter the Fish voice store. Deletion is
   * best-effort — the preview audio is already in hand by then.
   */
  async previewVoice({ audio, voice_name, prompt_text, preview_text }) {
    const previewName = voice_name || `nsp-${Date.now()}`;
    const cloneResult = await this.cloneVoice({ audio, voice_name: previewName, prompt_text });

    try {
      const pcmStream = await this.generatePcmStream({
        text: preview_text || 'This is a preview of the cloned voice.',
        voice_name: cloneResult.voice_id,
        speed: 1.0,
      });
      return { pcmStream, extraHeaders: {} };
    } finally {
      this.deleteVoice(cloneResult.voice_id).catch((err) => {
        log.warn('Fish preview cleanup failed (leftover clone)', { voiceId: cloneResult.voice_id, error: err.message });
      });
    }
  }

  async deleteVoice(voiceId) {
    const apiKey = this._getApiKey();

    const resp = await fetch(`${BASE_URL}/model/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Fish delete failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
    }

    this._voicesCache = null;
    return { success: true };
  }

  async mixVoices() {
    throw new Error('Voice mixing is not supported on Fish Audio.');
  }
}
