/**
 * Gemini / Google Generative Language cloud TTS adapter.
 *
 * Implements the same streaming PCM contract as WorkerProcess so the
 * API handlers (speech.js, voices.js) don't know the difference.
 *
 * Gemini API reference: docs/providers/gemini.md
 *
 * PCM contract: returns raw s16le 24kHz mono bytes via Node Readable.
 * Node's pipePcmToClient handles PCM→MP3/Opus/AAC transcode.
 *
 * Gemini TTS is fundamentally different from other providers: it is an
 * LLM that generates audio tokens from a prompt. There are no voice
 * cloning, speed, stability, or expressiveness sliders. Style control
 * is natural-language only (director's notes, scene descriptions, and
 * inline audio tags like [whispers]).
 */

import { Readable } from 'node:stream';
import { logger } from '../logger.js';
import { upstreamError } from './errors.js';

const log = logger.child('cloud.gemini');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
const API_REVISION = '2026-05-20';

/**
 * Static voice list — Gemini has no voices endpoint.
 * Names are case-sensitive and must match exactly.
 */
const GEMINI_VOICES = [
  { voice_id: 'Zephyr', name: 'Zephyr', character: 'Bright' },
  { voice_id: 'Puck', name: 'Puck', character: 'Upbeat' },
  { voice_id: 'Charon', name: 'Charon', character: 'Informative' },
  { voice_id: 'Kore', name: 'Kore', character: 'Firm' },
  { voice_id: 'Fenrir', name: 'Fenrir', character: 'Excitable' },
  { voice_id: 'Leda', name: 'Leda', character: 'Youthful' },
  { voice_id: 'Orus', name: 'Orus', character: 'Firm' },
  { voice_id: 'Aoede', name: 'Aoede', character: 'Breezy' },
  { voice_id: 'Callirrhoe', name: 'Callirrhoe', character: 'Easy-going' },
  { voice_id: 'Autonoe', name: 'Autonoe', character: 'Bright' },
  { voice_id: 'Enceladus', name: 'Enceladus', character: 'Breathy' },
  { voice_id: 'Iapetus', name: 'Iapetus', character: 'Clear' },
  { voice_id: 'Umbriel', name: 'Umbriel', character: 'Easy-going' },
  { voice_id: 'Algieba', name: 'Algieba', character: 'Smooth' },
  { voice_id: 'Despina', name: 'Despina', character: 'Smooth' },
  { voice_id: 'Erinome', name: 'Erinome', character: 'Clear' },
  { voice_id: 'Algenib', name: 'Algenib', character: 'Gravelly' },
  { voice_id: 'Rasalgethi', name: 'Rasalgethi', character: 'Informative' },
  { voice_id: 'Laomedeia', name: 'Laomedeia', character: 'Upbeat' },
  { voice_id: 'Achernar', name: 'Achernar', character: 'Soft' },
  { voice_id: 'Alnilam', name: 'Alnilam', character: 'Firm' },
  { voice_id: 'Schedar', name: 'Schedar', character: 'Even' },
  { voice_id: 'Gacrux', name: 'Gacrux', character: 'Mature' },
  { voice_id: 'Pulcherrima', name: 'Pulcherrima', character: 'Forward' },
  { voice_id: 'Achird', name: 'Achird', character: 'Friendly' },
  { voice_id: 'Zubenelgenubi', name: 'Zubenelgenubi', character: 'Casual' },
  { voice_id: 'Vindemiatrix', name: 'Vindemiatrix', character: 'Gentle' },
  { voice_id: 'Sadachbia', name: 'Sadachbia', character: 'Lively' },
  { voice_id: 'Sadaltager', name: 'Sadaltager', character: 'Knowledgeable' },
  { voice_id: 'Sulafat', name: 'Sulafat', character: 'Warm' },
];

/** Map nSpeech emotion values to Gemini audio tags. */
const EMOTION_TAGS = {
  happy: '[excitedly]',
  sad: '[sadly]',
  angry: '[shouting]',
  fearful: '[scared]',
  disgusted: '[disgusted]',
  surprised: '[surprised]',
  calm: '[calmly]',
  whisper: '[whispers]',
  fluent: '[smoothly]',
};

/**
 * Build the Gemini prompt from nSpeech fields.
 * Gemini performs best with a clear "Say..." preamble and director-style notes.
 */
function buildPrompt(text, instructions, emotion) {
  const parts = [];

  if (instructions) {
    parts.push(instructions.trim());
  }

  if (emotion && EMOTION_TAGS[emotion]) {
    parts.push(`Deliver with this quality: ${EMOTION_TAGS[emotion]}`);
  } else if (emotion) {
    parts.push(`Deliver with this quality: [${emotion}]`);
  }

  // Always end with a clear "Say:" directive so the model synthesizes speech.
  parts.push(`Say: ${text.trim()}`);

  return parts.join('\n\n');
}

/**
 * Map our extra_body fields to Gemini generation_config fields.
 * Most numeric sliders do not exist on Gemini; only the ones the model
 * actually understands are forwarded.
 */
function mapExtraBody(eb) {
  if (!eb || typeof eb !== 'object') return {};

  const mapped = {};

  if (eb.language) mapped.language = eb.language;

  return mapped;
}

/**
 * Extract base64 PCM audio from a Gemini Interaction response object.
 * Handles multiple response shapes:
 *   - output_audio.data
 *   - steps[].content[].data (with audio/* mime_type)
 *   - steps[].output_audio.data
 */
function _extractPcmFromResponse(data) {
  const chunks = [];

  if (data?.output_audio?.data) {
    chunks.push(Buffer.from(data.output_audio.data, 'base64'));
  }

  if (Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      if (step.output_audio?.data) {
        chunks.push(Buffer.from(step.output_audio.data, 'base64'));
      }
      if (Array.isArray(step.content)) {
        for (const part of step.content) {
          if (part.data && part.mime_type?.startsWith('audio/')) {
            chunks.push(Buffer.from(part.data, 'base64'));
          }
        }
      }
    }
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  if (total === 0) return null;

  return Buffer.concat(chunks, total);
}

export class GeminiAdapter {
  /** Per-request char limit (approximate — Gemini has no documented hard limit). Used by chunking. */
  get maxChars() { return 4800; }

  constructor() {
    this._apiKey = null;
  }

  /**
   * Lazy-load the API key from process.env (set by config.js from .env).
   * Fails fast if missing — no fallback, no default.
   */
  _getApiKey() {
    if (this._apiKey) return this._apiKey;

    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      const err = new Error('GEMINI_API_KEY not set in .env. Get your key from https://aistudio.google.com/apikey');
      err.status = 503;
      err.type = 'service_unavailable';
      err.code = 'cloud_unavailable';
      throw err;
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
   * Streaming is the default for 3.1 Flash TTS and uses SSE audio deltas.
   * Set extra_body.batch = true to disable streaming and receive one JSON blob.
   *
   * @param {object} params
   * @param {string} params.text
   * @param {string} params.voice_name  — Gemini voice name (case-sensitive)
   * @param {number} params.speed       — ignored (Gemini has no speed slider)
   * @param {string} [params.instruct_text]  — merged into the prompt as director's notes
   * @param {object} [params.extra_body]
   * @param {string} [params.model]     — model override (e.g. gemini-3.1-flash-tts-preview)
   * @returns {Promise<Readable>}
   */
  async generatePcmStream({ text, voice_name, speed, instruct_text, extra_body, model }) {
    const apiKey = this._getApiKey();
    const resolvedModel = model || DEFAULT_MODEL;
    const eb = mapExtraBody(extra_body);
    const isStreamingModel = resolvedModel.includes('3.1-flash-tts');

    const prompt = buildPrompt(text, instruct_text, extra_body?.emotion);

    const body = {
      model: resolvedModel,
      input: prompt,
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [
          { voice: voice_name || 'Kore' },
        ],
      },
    };

    if (eb.language) {
      body.generation_config.speech_config[0].language = eb.language;
    }

    const isBatch = extra_body?.batch === true;

    log.info('Gemini generate', {
      model: resolvedModel,
      voice: body.generation_config.speech_config[0].voice,
      textLen: text.length,
      batch: isBatch,
      textPreview: (text || '').slice(0, 200) + ((text || '').length > 200 ? '...' : ''),
    });

    const url = `${BASE_URL}/interactions`;
    const fetchOpts = {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        'Api-Revision': API_REVISION,
      },
      body: JSON.stringify(body),
    };

    // Streaming path (3.1 Flash TTS) — body-level stream:true yields SSE audio deltas.
    if (isStreamingModel && !isBatch) {
      fetchOpts.body = JSON.stringify({ ...body, stream: true });
      return this._generateStreaming({ url, fetchOpts });
    }

    // Batch fallback for older / non-streaming models
    return this._generateBatch({ url, fetchOpts });
  }

  async _generateBatch({ url, fetchOpts, attempt = 1 }) {
    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      const errText = await resp.text();
      log.error('Gemini TTS failed', { status: resp.status, body: errText.slice(0, 500) });

      // Retry once on 5xx flaky model errors.
      if (resp.status >= 500 && attempt === 1) {
        log.warn('Gemini TTS 5xx, retrying once', { status: resp.status });
        return this._generateBatch({ url, fetchOpts, attempt: attempt + 1 });
      }

      throw upstreamError(resp.status, errText, 'Gemini TTS failed', 'model_not_found');
    }

    const data = await resp.json();
    const pcmBuf = _extractPcmFromResponse(data);
    if (!pcmBuf) {
      throw new Error('Gemini TTS failed: no audio in response');
    }

    log.info('Gemini batch PCM', { bytes: pcmBuf.length });
    return Readable.from([pcmBuf]);
  }

  async _generateStreaming({ url, fetchOpts, attempt = 1 }) {
    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      const errText = await resp.text();
      log.error('Gemini streaming TTS failed', { status: resp.status, body: errText.slice(0, 500) });

      if (resp.status >= 500 && attempt === 1) {
        log.warn('Gemini streaming TTS 5xx, retrying once', { status: resp.status });
        return this._generateStreaming({ url, fetchOpts, attempt: attempt + 1 });
      }

      throw upstreamError(resp.status, errText, 'Gemini TTS failed', 'model_not_found');
    }

    const nodeStream = new Readable({ read() {} });
    this._pumpSseAudio(resp.body, nodeStream);
    return nodeStream;
  }

  /**
   * Pump SSE audio deltas from a web ReadableStream into a Node Readable.
   * Decodes base64 PCM chunks as they arrive so ffmpeg can transcode immediately.
   */
  async _pumpSseAudio(webStream, nodeStream) {
    const reader = webStream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;

    const finish = (err) => {
      if (err) {
        nodeStream.destroy(err);
        return;
      }
      if (nodeStream.readable) {
        nodeStream.push(null);
      }
      log.info('Gemini streaming PCM', { bytes: totalBytes });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const event = this._parseSseBlock(block);
          if (!event) continue;

          if (event.event_type === 'step.delta' && event.delta?.data && event.delta.mime_type?.startsWith('audio/')) {
            const pcm = Buffer.from(event.delta.data, 'base64');
            if (pcm.length) {
              totalBytes += pcm.length;
              nodeStream.push(pcm);
            }
          } else if (event.event_type === 'done' || event.event_type === 'interaction.completed' || event.event_type === 'step.stop') {
            finish();
            return;
          } else if (event.error) {
            finish(new Error(`Gemini streaming error: ${event.error.message || JSON.stringify(event.error)}`));
            return;
          }
        }
      }
    } catch (err) {
      finish(err);
    }
  }

  /**
   * Parse a single SSE event block into { event_type, ...parsedData }.
   * Returns null if the block contains no parseable data payload.
   */
  _parseSseBlock(block) {
    const lines = block.split('\n');
    let eventName = null;
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      }
    }

    if (!dataLines.length) return null;

    try {
      const data = JSON.parse(dataLines.join('\n'));
      return { event_type: eventName ?? data.event_type, ...data };
    } catch {
      return { event_type: eventName, raw: dataLines.join('\n') };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Voice management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List voices — returns the static 30 Gemini voices.
   */
  async listVoices() {
    return {
      voices: GEMINI_VOICES.map(v => ({
        voice_id: v.voice_id,
        name: v.name,
        category: 'builtin',
        voice_type: 'gemini_system',
        engine: 'gemini',
        description: v.character,
        language: 'auto',
      })),
    };
  }

  // Gemini has no voice cloning, preview, delete, or mixing endpoints.

  async cloneVoice() {
    throw new Error('Voice cloning is not supported on Gemini.');
  }

  async previewVoice() {
    throw new Error('Voice preview cloning is not supported on Gemini.');
  }

  async deleteVoice() {
    throw new Error('Voice deletion is not supported on Gemini.');
  }

  async mixVoices() {
    throw new Error('Voice mixing is not supported on Gemini.');
  }
}
