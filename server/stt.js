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
import { config } from './config.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

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
 * @param {Buffer} pcm — audio bytes: WAV, raw s16le 24kHz mono PCM, or a
 *   compressed container (MP3/FLAC/Ogg) decoded via ffmpeg
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

  // Input contract (detected by magic bytes — see normalizeToWav):
  //   WAV container       → pass through (soundfile reads it)
  //   raw s16le 24kHz PCM → wrap in a WAV header (from chunking.js)
  //   compressed (MP3/…)  → ffmpeg-decode to 24kHz mono s16le WAV
  const wav = await normalizeToWav(pcm);
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
 * @param {Buffer} opts.audio — audio bytes (WAV, raw PCM, or compressed
 *   MP3/FLAC/Ogg — decoded via ffmpeg server-side)
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

  const wav = await normalizeToWav(audio);
  const fields = [
    { name: 'file', value: wav, filename: 'audio.wav', contentType: 'audio/wav' },
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

/**
 * Classify an audio buffer by magic bytes so we know how to prepare it for
 * the worker (which reads via soundfile → WAV/FLAC/Ogg but NOT MP3).
 * @param {Buffer} buf
 * @returns {'wav'|'compressed'|'pcm'}
 */
function detectAudioContainer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return 'pcm';
  const b = buf;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav';   // "RIFF"
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'compressed';              // "ID3" (MP3)
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'compressed';                       // MP3 frame sync
  if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'compressed'; // "fLaC"
  if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'compressed'; // "OggS"
  return 'pcm';
}

/**
 * Decode any compressed container (MP3/FLAC/Ogg/…) to raw s16le 24kHz mono
 * PCM via ffmpeg, then wrap in a WAV header. The decode direction is the
 * inverse of transcode.js (which is PCM → compressed).
 * @param {Buffer} input
 * @returns {Promise<Buffer>} WAV bytes
 */
function decodeToWav(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ar', '24000', '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode failed (exit ${code}): ${stderr.trim() || 'unknown error'}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) {
        reject(new Error('ffmpeg decode produced no audio'));
        return;
      }
      resolve(pcmToWav(pcm));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * Normalize an audio buffer to the worker's input contract (WAV).
 * WAV passes through; raw PCM is header-wrapped; compressed containers are
 * ffmpeg-decoded. Fails loudly if ffmpeg is missing and it's actually needed.
 * @param {Buffer} buf
 * @returns {Promise<Buffer>} WAV bytes
 */
async function normalizeToWav(buf) {
  const kind = detectAudioContainer(buf);
  if (kind === 'wav') return buf;
  if (kind === 'pcm') return pcmToWav(buf);
  if (!existsSync(config.ffmpegPath)) {
    throw new Error(`ffmpeg not found at ${config.ffmpegPath}. Run nVideo setup (lib/nvideo/scripts/download-ffmpeg.js).`);
  }
  return decodeToWav(buf);
}

/** Health probe for the STT worker (does not spawn it). */
export function sttStatus() {
  const w = manager.workers.get(STT_ENGINE);
  return {
    engine: STT_ENGINE,
    state: w ? w.state : 'not-started',
  };
}
