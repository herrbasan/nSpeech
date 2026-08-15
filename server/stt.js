/**
 * STT service — nSpeech's own transcription + forced alignment worker.
 *
 * A dedicated CPU worker (venv/stt, registry entry "stt", gpu:false) seeded
 * from the same WorkerProcess lifecycle as TTS engines. Engine switching in
 * nSpeech or nVoice can never disturb it: gpu:false means no eviction, and
 * it is filtered out of the TTS engine surface.
 *
 * Endpoints (worker-native, translated here):
 *   POST /v1/audio/align          — MMS CTC forced alignment (text-constrained)
 *   POST /v1/audio/transcriptions — faster-whisper large-v3 int8 transcription
 *
 * The align contract mirrors what chunking.js consumed from nVoice:
 *   request:  multipart { file: WAV, text: string }
 *   response: { text, duration, words: [{word, start, end, probability}] }
 */
import { manager } from './engine/manager.js';
import { WorkerError } from './engine/worker.js';
import { logger } from './logger.js';

const log = logger.child('stt');

const STT_ENGINE = 'stt';
const ALIGN_TIMEOUT_MS = 300_000; // long-audio safety (MMS is RTF ~0.2 CPU)

/**
 * Get the STT worker (lazy-start, restart on death). Throws loudly if
 * the venv or worker module is missing — never silently degrades.
 * @returns {Promise<import('./engine/worker.js').WorkerProcess>}
 */
async function getSttWorker() {
  return manager.getWorker(STT_ENGINE);
}

/**
 * Build a multipart body with zero dependencies.
 * @param { Array<{name:string, value:Buffer|string, filename?:string, contentType?:string}> } fields
 * @returns {{ body: Buffer, contentType: string }}
 */
function buildMultipart(fields) {
  const boundary = `----nspeechStt${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    const cd = f.filename !== undefined
      ? `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n`
        + `Content-Type: ${f.contentType ?? 'application/octet-stream'}\r\n\r\n`
      : `Content-Disposition: form-data; name="${f.name}"\r\n\r\n`;
    parts.push(Buffer.from(cd));
    parts.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(String(f.value)));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Forced-align PCM audio against known text (MMS CTC — constrained Viterbi).
 *
 * Word count in `words` is guaranteed to equal text.split().length; the
 * stitching trim relies on this to index the first post-overlap word.
 *
 * @param {Buffer} pcm — s16le 24kHz mono PCM
 * @param {string} text — the exact text spoken in the audio
 * @returns {Promise<{text: string, duration: number, words: Array<{word: string, start: number, end: number, probability: number}>}>}
 */
export async function alignPcm(pcm, text) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    throw new Error('stt.alignPcm: pcm Buffer required');
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('stt.alignPcm: non-empty text required');
  }

  const worker = await getSttWorker();

  // Input contract: WAV container bytes (from the routes) OR raw s16le
  // 24kHz mono PCM (from chunking.js). Only the latter needs a header —
  // the worker decodes via soundfile, which requires a container. RIFF
  // magic detects an existing WAV.
  const wav = (pcm.length > 12 && pcm.readUInt32BE(0) === 0x52494646) ? pcm : pcmToWav(pcm);
  const { body, contentType } = buildMultipart([
    { name: 'file', value: wav, filename: 'audio.wav', contentType: 'audio/wav' },
    { name: 'text', value: text },
  ]);

  const resp = await worker.relay('POST', '/v1/audio/align', {
    headers: { 'content-type': contentType },
    body,
    streamTimeoutMs: ALIGN_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new WorkerError(502, 'stt_align_failed',
      `STT align failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Transcribe audio (faster-whisper large-v3 int8 CPU).
 *
 * @param {object} opts
 * @param {Buffer} opts.audio — audio bytes (WAV; any container ffmpeg-free
 *   decoders handle — soundfile reads WAV/flac/ogg)
 * @param {string} [opts.language] — ISO code; omit for auto-detect
 * @param {boolean} [opts.wordTimestamps] — include word-level timestamps
 * @param {boolean} [opts.segmentTimestamps] — include segment breaks
 * @returns {Promise<object>} — { text, language, duration, segments?, words? }
 */
export async function transcribe({ audio, language, wordTimestamps, segmentTimestamps }) {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new Error('stt.transcribe: audio Buffer required');
  }

  const worker = await getSttWorker();

  const fields = [
    { name: 'file', value: audio, filename: 'audio.wav', contentType: 'audio/wav' },
  ];
  if (language) fields.push({ name: 'language', value: language });
  if (wordTimestamps) fields.push({ name: 'word_timestamps', value: 'true' });

  const { body, contentType } = buildMultipart(fields);

  const resp = await worker.relay('POST', '/v1/audio/transcriptions', {
    headers: { 'content-type': contentType },
    body,
    streamTimeoutMs: ALIGN_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new WorkerError(502, 'stt_transcribe_failed',
      `STT transcribe failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (segmentTimestamps === false) {
    delete data.segments;
  }
  return data;
}

/**
 * Wrap raw s16le PCM in a 44-byte WAV header (24kHz mono).
 * @param {Buffer} pcm
 * @returns {Buffer}
 */
function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);      // PCM
  header.writeUInt16LE(1, 22);      // mono
  header.writeUInt32LE(24000, 24);  // sample rate — the nSpeech PCM contract
  header.writeUInt32LE(48000, 28);  // byte rate
  header.writeUInt16LE(2, 32);      // block align
  header.writeUInt16LE(16, 34);     // bits
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Health probe for the STT worker (does not spawn it). */
export function sttStatus() {
  const w = manager.workers.get(STT_ENGINE);
  return {
    engine: STT_ENGINE,
    state: w ? w.state : 'not-started',
  };
}
