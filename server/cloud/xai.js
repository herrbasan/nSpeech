/**
 * xAI / Grok Voice cloud TTS adapter.
 *
 * Implements the same PCM contract as WorkerProcess so the API handlers
 * (speech.js, voices.js) don't know the difference.
 *
 * xAI API reference: docs/providers/xai.md
 *
 * PCM contract: returns raw s16le 24kHz mono bytes via Node Readable.
 * Node's pipePcmToClient handles PCM→MP3/Opus/AAC transcode.
 *
 * NOTE: xAI's unary HTTP endpoint returns the full audio as one response
 * (no SSE streaming). True streaming is only available via WebSocket.
 * For nSpeech, we request PCM and return the full buffer — effectively
 * always "batch" from the client's perspective. The WS streaming endpoint
 * can be added later for real-time TTS with barge-in.
 */

import { Readable } from 'node:stream';
import { logger } from '../logger.js';

const log = logger.child('cloud.xai');

const BASE_URL = 'https://api.x.ai';
const VOICES_CACHE_TTL_MS = 300_000; // 5 minutes

/** Map our extra_body fields to xAI-native request params. */
function mapExtraBody(eb) {
  if (!eb || typeof eb !== 'object') return {};

  const mapped = {};

  // Voice character
  if (eb.expressiveness !== undefined) mapped.expressiveness = eb.expressiveness;

  // Quality — xAI has no inference_steps/guidance_scale equivalent

  // Text processing
  if (eb.language) mapped.language = eb.language;
  if (eb.text_normalization) mapped.text_normalization = true;

  // Audio output
  if (eb.sample_rate) mapped.sample_rate = eb.sample_rate;
  if (eb.bitrate) mapped.bitrate = eb.bitrate;

  // Streaming optimization (0=best quality, 2=lowest TTFA)
  if (eb.optimize_latency !== undefined) mapped.optimize_latency = eb.optimize_latency;

  return mapped;
}

export class XaiAdapter {
  constructor() {
    this._apiKey = null;
    this._voicesCache = null;
    this._voicesCacheTime = 0;
  }

  /** Lazy-load the API key from process.env. Fails fast if missing. */
  _getApiKey() {
    if (this._apiKey) return this._apiKey;

    const key = process.env.XAI_API_KEY;
    if (!key) {
      throw new Error('XAI_API_KEY not set in .env. Get your key from https://console.x.ai/team/default/api-keys');
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
   * xAI's HTTP endpoint returns the full audio in one response (no SSE
   * streaming). We request PCM at 24kHz and return the full buffer.
   *
   * @param {object} params
   * @param {string} params.text
   * @param {string} params.voice_name  — xAI voice_id (eve, ara, rex, sal, leo)
   * @param {number} params.speed       — 0.7–1.5
   * @param {string} [params.instruct_text]  — ignored (xAI uses speech tags in text)
   * @param {object} [params.extra_body]
   * @param {string} [params.model]     — not used (xAI has no model param)
   * @returns {Promise<Readable>}
   */
  async generatePcmStream({ text, voice_name, speed, instruct_text, extra_body, model }) {
    const apiKey = this._getApiKey();
    const eb = mapExtraBody(extra_body);

    const body = {
      text,
      voice_id: voice_name || 'eve',
      language: eb.language || 'auto',
      output_format: {
        codec: 'pcm',
        sample_rate: eb.sample_rate ?? 24000,
      },
      speed: speed ?? 1.0,
      optimize_streaming_latency: eb.optimize_latency ?? 0,
    };

    if (eb.bitrate !== undefined) body.output_format.bit_rate = eb.bitrate;
    if (eb.text_normalization) body.text_normalization = true;

    log.info('xAI generate', {
      voice: body.voice_id, textLen: text.length,
      language: body.language, speed: body.speed,
      textPreview: (text || '').slice(0, 200) + ((text || '').length > 200 ? '...' : ''),
    });

    const resp = await fetch(`${BASE_URL}/v1/tts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.error('xAI TTS failed', { status: resp.status, body: errText.slice(0, 500) });
      throw new Error(`xAI TTS failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
    }

    // xAI returns raw audio bytes (PCM in our case)
    const pcmBuf = Buffer.from(await resp.arrayBuffer());
    log.info('xAI PCM received', { bytes: pcmBuf.length });

    return Readable.from([pcmBuf]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Voice management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List voices — returns xAI's 5 built-in voices + custom cloned voices.
   * Cached for 5 minutes.
   */
  async listVoices() {
    const now = Date.now();
    if (this._voicesCache && (now - this._voicesCacheTime) < VOICES_CACHE_TTL_MS) {
      return this._voicesCache;
    }

    const apiKey = this._getApiKey();

    try {
      // Fetch built-in voices
      const builtinResp = await fetch(`${BASE_URL}/v1/tts/voices`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      const voices = [];

      if (builtinResp.ok) {
        const data = await builtinResp.json();
        for (const v of data.voices || []) {
          voices.push({
            voice_id: v.voice_id,
            name: v.name || v.voice_id,
            category: 'builtin',
            voice_type: 'xai_system',
            engine: 'xai',
          });
        }
      }

      // Fetch custom cloned voices
      try {
        const customResp = await fetch(`${BASE_URL}/v1/custom-voices`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });

        if (customResp.ok) {
          const customData = await customResp.json();
          for (const v of customData.voices || []) {
            voices.push({
              voice_id: v.voice_id,
              name: v.name || v.voice_id,
              category: 'cloned',
              voice_type: 'xai_cloned',
              engine: 'xai',
            });
          }
        }
      } catch {
        // Custom voices might not exist — that's fine
      }

      this._voicesCache = { voices };
      this._voicesCacheTime = now;

      log.info('xAI voices loaded', { count: voices.length });
      return this._voicesCache;
    } catch (err) {
      log.error('xAI voice list error', { error: err.message });
      return { voices: [] };
    }
  }

  /**
   * Clone a voice from reference audio.
   * Uses xAI's /v1/custom-voices endpoint (multipart upload).
   */
  async cloneVoice({ audio, voice_name, prompt_text }) {
    const apiKey = this._getApiKey();

    const form = new FormData();
    form.append('name', voice_name);
    form.append('file', new Blob([audio], { type: 'audio/wav' }), `${voice_name}.wav`);
    if (prompt_text) form.append('description', prompt_text);

    const resp = await fetch(`${BASE_URL}/v1/custom-voices`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let detail = errText;
      try {
        const errJson = JSON.parse(errText);
        detail = errJson.error || errJson.message || errText;
      } catch {}
      log.error('xAI clone failed', { status: resp.status, body: errText.slice(0, 300) });
      throw new Error(`xAI clone failed: HTTP ${resp.status} — ${detail}`);
    }

    const data = await resp.json();
    this._voicesCache = null;

    return {
      voice_id: data.voice_id || voice_name,
      name: voice_name,
      category: 'cloned',
      engine: 'xai',
    };
  }

  async previewVoice({ audio, voice_name, prompt_text, preview_text }) {
    const previewName = voice_name || `tmp${Date.now()}`;

    // Clone first
    const cloneResult = await this.cloneVoice({ audio, voice_name: previewName, prompt_text });

    // Generate preview
    const pcmStream = await this.generatePcmStream({
      text: preview_text || 'This is a preview of the cloned voice.',
      voice_name: cloneResult.voice_id,
      speed: 1.0,
    });

    return { pcmStream, extraHeaders: {} };
  }

  async deleteVoice(voiceId) {
    const apiKey = this._getApiKey();

    // xAI doesn't document a DELETE endpoint for custom voices.
    // Custom voices auto-expire after inactivity, so we return success
    // to avoid blocking the UI.
    log.warn('xAI deleteVoice called but no delete endpoint exists', { voiceId });
    this._voicesCache = null;
    return { success: true, note: 'xAI custom voices auto-expire after inactivity' };
  }

  async mixVoices() {
    throw new Error('Voice mixing is not supported on xAI.');
  }
}
