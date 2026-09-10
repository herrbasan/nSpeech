/**
 * ElevenLabs cloud TTS adapter.
 *
 * Simpler than MiniMax: raw binary PCM (no hex decode), single-step
 * voice cloning (no 3-step upload dance), standard DELETE for voices.
 *
 * PCM contract: returns raw s16le 24kHz mono bytes via Node Readable.
 * Node's pipePcmToClient handles PCM→MP3/Opus/AAC transcode.
 *
 * ElevenLabs API reference: docs/providers/elevenlabs.md
 */

import { Readable } from 'node:stream';
import { logger } from '../logger.js';
import { upstreamError } from './errors.js';
import { clampNumber } from './params.js';

const log = logger.child('cloud.elevenlabs');

const BASE_URL = 'https://api.elevenlabs.io';
const VOICES_CACHE_TTL_MS = 300_000; // 5 minutes

// VoiceSettings.speed range. Verified 2026-09-10: eleven_flash_v2_5 accepts 0.7
// and 1.2 and rejects 1.21 with `invalid_voice_settings`; eleven_v3 happens to
// accept wider values but is clamped to the same documented range so every
// model behaves identically. See cloud/params.js.
const SPEED_RANGE = { name: 'speed', min: 0.7, max: 1.2, provider: 'ElevenLabs', fallback: 1.0 };

function mapExtraBody(eb) {
  if (!eb || typeof eb !== 'object') return {};
  const m = {};
  if (eb.stability !== undefined) m.stability = eb.stability;
  if (eb.guidance_scale !== undefined) m.similarity_boost = eb.guidance_scale;
  if (eb.expressiveness !== undefined) m.style = eb.expressiveness;
  if (eb.seed !== undefined) m.seed = eb.seed;
  return m;
}

export class ElevenLabsAdapter {
  /** Per-request char limit (API limit minus safety margin). Used by chunking.
   * Note: this is the limit for the DEFAULT model (eleven_v3). For model-aware
   * limits, use getMaxChars(model) — v3=5K, multilingual_v2=10K, flash_v2.5=40K. */
  get maxChars() { return 4800; }

  /** Model-aware char limit. Returns the limit for the given model ID minus safety margin. */
  getMaxChars(model) {
    const limits = {
      'eleven_v3': 5000,
      'eleven_multilingual_v2': 10000,
      'eleven_flash_v2_5': 40000,
      'eleven_flash_v2': 30000,
    };
    const limit = limits[model] ?? limits['eleven_v3'];
    return Math.floor(limit * 0.96); // 4% safety margin
  }

  constructor() {
    this._apiKey = null;
    this._voicesCache = null;
    this._voicesCacheTime = 0;
  }

  _getApiKey() {
    if (this._apiKey) return this._apiKey;
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY not set in .env. Get your key from https://elevenlabs.io/app/settings/api-keys');
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

  async generatePcmStream({ text, voice_name, speed, instruct_text, extra_body, model }) {
    const apiKey = this._getApiKey();
    const eb = mapExtraBody(extra_body);
    const voiceId = voice_name || 'JBFqnCBsd6RMkjVDRZzb'; // George default
    const isBatch = (extra_body?.batch) ?? false;

    const voiceSettings = {
      stability: eb.stability ?? 0.5,
      similarity_boost: eb.similarity_boost ?? 0.75,
      style: eb.style ?? 0,
      use_speaker_boost: true,
      // Previously `speed` was destructured and then never sent, so the API's
      // speed control silently did nothing on this provider.
      speed: clampNumber(speed, SPEED_RANGE),
    };

    const reqBody = {
      text,
      model_id: model || 'eleven_v3',
      voice_settings: voiceSettings,
    };
    if (eb.seed !== undefined) reqBody.seed = eb.seed;
    if (extra_body?.language) reqBody.language_code = extra_body.language;
    // Continuity context for multi-request sequences (auto-chunking).
    // previous_text/next_text give the engine prosody context across chunks.
    // NOTE: eleven_v3 does NOT support these fields (HTTP 400 unsupported_model).
    // Only inject for v2 models (eleven_multilingual_v2, eleven_turbo_v2_5, etc.).
    const supportsContinuity = !reqBody.model_id.startsWith('eleven_v3');
    if (supportsContinuity) {
      if (extra_body?.previous_text) reqBody.previous_text = extra_body.previous_text;
      if (extra_body?.next_text) reqBody.next_text = extra_body.next_text;
    }

    log.info('ElevenLabs generate', {
      model: reqBody.model_id, voice: voiceId, textLen: text.length,
      batch: isBatch, textPreview: (text || '').slice(0, 200),
    });

    // optimize_streaming_latency is deprecated AND rejected by eleven_v3.
    // Only include it for legacy v2 models. New models should not see it.
    const latencyParam = reqBody.model_id.startsWith('eleven_v3') ? '' : '&optimize_streaming_latency=3';

    if (isBatch) {
      // ── Batch: full render before first byte ────────────────────────────
      const url = `${BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_24000${latencyParam}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        log.error('ElevenLabs batch TTS failed', { status: resp.status, body: errText.slice(0, 300) });
        throw upstreamError(resp.status, errText, 'ElevenLabs TTS failed');
      }

      const pcmBuf = Buffer.from(await resp.arrayBuffer());
      log.info('ElevenLabs batch PCM', { bytes: pcmBuf.length });
      return Readable.from([pcmBuf]);
    }

    // ── Streaming: progressive chunks via SSE ────────────────────────────
    const url = `${BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_24000`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.error('ElevenLabs stream TTS failed', { status: resp.status, body: errText.slice(0, 300) });
      throw upstreamError(resp.status, errText, 'ElevenLabs TTS failed');
    }

    // ElevenLabs stream returns raw PCM chunks — pipe directly into Readable
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

  async listVoices() {
    const now = Date.now();
    if (this._voicesCache && (now - this._voicesCacheTime) < VOICES_CACHE_TTL_MS) {
      return this._voicesCache;
    }

    const apiKey = this._getApiKey();

    try {
      const resp = await fetch(`${BASE_URL}/v2/voices?page_size=100&voice_type=personal`, {
        headers: { 'xi-api-key': apiKey },
      });

      if (!resp.ok) {
        log.warn('ElevenLabs voice list failed', { status: resp.status });
        return { voices: [] };
      }

      const data = await resp.json();
      const voices = [];

      for (const v of data.voices || []) {
        const lang = (v.labels?.language || v.verified_languages?.[0]?.language || 'en');
        voices.push({
          voice_id: v.voice_id,
          name: v.name || v.voice_id,
          category: v.category === 'cloned' ? 'cloned' : 'builtin',
          voice_type: v.category === 'cloned' ? 'elevenlabs_cloned' : 'elevenlabs_system',
          engine: 'elevenlabs',
          language: lang,
          description: v.description || '',
          labels: v.labels || {},
          preview_url: v.preview_url || null,
        });
      }

      this._voicesCache = { voices };
      this._voicesCacheTime = now;

      log.info('ElevenLabs voices loaded', { count: voices.length });
      return this._voicesCache;
    } catch (err) {
      log.error('ElevenLabs voice list error', { error: err.message });
      return { voices: [] };
    }
  }

  async cloneVoice({ audio, voice_name, prompt_text }) {
    const apiKey = this._getApiKey();

    const form = new FormData();
    form.append('name', voice_name);
    form.append('files', new Blob([audio], { type: 'audio/wav' }), `${voice_name}.wav`);
    if (prompt_text) form.append('description', prompt_text);

    const resp = await fetch(`${BASE_URL}/v1/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw upstreamError(resp.status, errText, 'ElevenLabs clone failed');
    }

    const data = await resp.json();
    this._voicesCache = null;

    return {
      voice_id: data.voice_id || voice_name,
      name: voice_name,
      category: 'cloned',
      engine: 'elevenlabs',
    };
  }

  async previewVoice({ audio, voice_name, prompt_text, preview_text }) {
    const previewName = voice_name || `tmp${Date.now()}`;

    // Clone first (creates a real cloned voice)
    const cloneResult = await this.cloneVoice({ audio, voice_name: previewName, prompt_text });

    // Generate preview audio using the cloned voice_id
    const pcmStream = await this.generatePcmStream({
      text: preview_text || 'This is a preview of the cloned voice.',
      voice_name: cloneResult.voice_id,
      speed: 1.0,
    });

    return { pcmStream, extraHeaders: {} };
  }

  async deleteVoice(voiceId) {
    const apiKey = this._getApiKey();

    const resp = await fetch(`${BASE_URL}/v1/voices/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw upstreamError(resp.status, errText, 'ElevenLabs delete failed');
    }

    this._voicesCache = null;
    return { success: true };
  }

  async mixVoices() {
    throw new Error('Voice mixing is not supported on ElevenLabs.');
  }
}
