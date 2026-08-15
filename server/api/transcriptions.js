/**
 * STT and forced alignment — nSpeech's OWN offering (local STT worker).
 *
 * Routes:
 *   POST /v1/audio/transcriptions — speech-to-text (faster-whisper large-v3
 *                                   int8 CPU, via the "stt" engine worker)
 *   POST /v1/audio/align          — forced alignment, text-constrained
 *                                   (torchaudio MMS_FA CTC)
 *
 * Both multipart: field `file` (WAV/FLAC), optional `language`,
 * `word_timestamps` (transcriptions) and `text` (align).
 *
 * Until 2026-08-14 these were a transparent proxy to nVoice — which made
 * nSpeech's chunk stitching depend on nVoice's engine lifecycle (switching
 * engines there could evict the aligner). The local worker is CPU-only and
 * gpu:false: nothing can evict it, and transcription becomes a first-class
 * nSpeech feature.
 */
import * as stt from '../stt.js';
import { logger } from '../logger.js';

const log = logger.child('stt-api');

/**
 * Extract file bytes and text fields from a raw multipart/form-data buffer.
 * This server deliberately registers NO multipart parser plugin (see
 * index.js — plugins drain request.raw); we get the raw bytes in
 * request.body and parse them here, zero-dependency. The first file part
 * wins; later duplicate fields overwrite earlier ones.
 * @param {Buffer} raw — full multipart body
 * @param {string} contentType — request content-type header (has the boundary)
 * @returns {{ file: {buf: Buffer, filename: string}, fields: Record<string,string> }}
 */
function parseMultipart(raw, contentType) {
  const m = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType ?? '');
  if (!m) throw Object.assign(new Error('missing multipart boundary'), { statusCode: 400, code: 'bad_multipart' });
  const boundary = `--${(m[1] ?? m[2]).trim()}`;

  const file = { buf: null, filename: 'audio' };
  const fields = {};

  // Split on CRLF-prefixed boundary (standard form-data framing)
  let start = raw.indexOf(boundary);
  while (start !== -1) {
    const headStart = start + boundary.length;
    // terminal boundary "--"
    if (raw[headStart] === 0x2d && raw[headStart + 1] === 0x2d) break;
    // skip CRLF after boundary
    let pos = headStart + (raw[headStart] === 0x0d ? 2 : 0);
    const headEnd = raw.indexOf('\r\n\r\n', pos);
    if (headEnd === -1) break;
    const head = raw.subarray(pos, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;
    const next = raw.indexOf(boundary, bodyStart);
    if (next === -1) break;
    // body ends with CRLF before the next boundary
    const bodyEnd = next - 2;
    const body = raw.subarray(bodyStart, bodyEnd);

    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    if (nameM) {
      if (fileM) {
        if (file.buf === null) { file.buf = Buffer.from(body); file.filename = fileM[1]; }
      } else {
        fields[nameM[1]] = body.toString('utf8');
      }
    }
    start = next;
  }

  if (file.buf === null) {
    throw Object.assign(new Error("multipart field 'file' missing"), { statusCode: 400, code: 'missing_file' });
  }
  return { file, fields };
}

/**
 * Register STT routes on a Fastify instance.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSttRoutes(app) {

  // ── POST /v1/audio/transcriptions ────────────────────────────────────────

  app.post('/v1/audio/transcriptions', async (request, reply) => {
    let parsed;
    try {
      parsed = parseMultipart(request.body, request.headers['content-type']);
    } catch (err) {
      return reply.code(err.statusCode ?? 400).send({
        error: { message: err.message, type: 'invalid_request_error', code: err.code ?? 'bad_request' },
      });
    }

    const audio = parsed.file.buf;
    const fields = parsed.fields;

    try {
      const result = await stt.transcribe({
        audio,
        language: fields.language || undefined,
        wordTimestamps: fields.word_timestamps === 'true' || fields.word_timestamps === true,
        segmentTimestamps: true,
      });
      log.info('transcription complete', {
        bytes: audio.length,
        language: result.language,
        duration: result.duration,
      });
      return reply.send(result);
    } catch (err) {
      log.error('transcription failed', { error: err.message });
      return reply.code(err.statusCode ?? 500).send({
        error: {
          message: err.message,
          type: err.code?.startsWith('stt_') ? 'engine_error' : 'api_error',
          code: err.code ?? 'stt_error',
        },
      });
    }
  });

  // ── POST /v1/audio/align ─────────────────────────────────────────────────

  app.post('/v1/audio/align', async (request, reply) => {
    let parsed;
    try {
      parsed = parseMultipart(request.body, request.headers['content-type']);
    } catch (err) {
      return reply.code(err.statusCode ?? 400).send({
        error: { message: err.message, type: 'invalid_request_error', code: err.code ?? 'bad_request' },
      });
    }

    const text = parsed.fields.text;
    if (typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({
        error: {
          message: "Missing required field 'text'",
          type: 'invalid_request_error',
          code: 'missing_text',
          param: 'text',
        },
      });
    }

    const audio = parsed.file.buf;

    try {
      const result = await stt.alignPcm(audio, text);
      log.info('alignment complete', {
        bytes: audio.length,
        duration: result.duration,
        words: result.words.length,
      });
      return reply.send(result);
    } catch (err) {
      log.error('alignment failed', { error: err.message });
      return reply.code(err.statusCode ?? 500).send({
        error: {
          message: err.message,
          type: err.code?.startsWith('stt_') ? 'engine_error' : 'api_error',
          code: err.code ?? 'stt_error',
        },
      });
    }
  });
}
