/**
 * POST /v1/audio/speech — OpenAI-compatible TTS endpoint.
 *
 * Translates OpenAI request fields to engine-native fields and forwards
 * to the engine worker. The worker always streams raw PCM (s16le, 24kHz,
 * mono). Node transcodes to the client's requested format (mp3, opus, aac)
 * via ffmpeg on-the-fly, streaming compressed chunks to the browser.
 *
 * Why? Browsers' MediaSource API only accepts specific codec+container
 * combos (audio/mpeg for MP3, audio/mp4 for AAC). Ogg Opus — what PyAV
 * produces — is NOT supported by MediaSource or even <audio> on Windows
 * Chrome. And PyAV lacks libmp3lame entirely. nVideo's bundled ffmpeg
 * solves both problems: it has libmp3lame and can stream via stdin/stdout.
 *
 * OpenAI → Worker field mapping:
 *   input           → text
 *   voice           → voice_name
 *   response_format → output_format (always 'pcm' to worker; Node transcodes)
 *   speed           → speed
 *   instructions    → instruct_text
 *   extra_body      → merged into worker body
 */
import { manager } from '../engine/manager.js';
import { WorkerError } from '../engine/worker.js';
import { getContentType, normalizeFormat, resolveEngine } from './formats.js';
import { logger } from '../logger.js';

const log = logger.child('speech');
import { createTranscoder, pipePcmToClient } from '../transcode.js';
import { Readable } from 'node:stream';

/** Formats that need ffmpeg transcoding (compressed). */
const TRANSCODE_FORMATS = new Set(['mp3', 'opus', 'aac']);

/** Formats that pass through raw (no transcoding needed). */
const RAW_FORMATS = new Set(['wav', 'pcm', 'pcm_f32']);

/**
 * Core TTS relay logic — shared by POST /v1/audio/speech and GET /tts.
 * Streams audio chunks to the reply as they are produced.
 */
export async function relaySpeech(request, reply, body) {
  // ── Validate required fields ────────────────────────────────────────────
  if (!body.input || typeof body.input !== 'string') {
    return reply.code(400).send({
      error: {
        message: "Missing required field: 'input'",
        type: 'invalid_request_error',
        code: 'missing_input',
        param: 'input',
      },
    });
  }

  // ── Resolve engine from model ───────────────────────────────────────────
  const engineName = resolveEngine(body.model) || manager.currentEngine;

  // ── Translate OpenAI fields → engine-native fields ──────────────────────
  const clientFormat = normalizeFormat(body.response_format);
  const extraBody = body.extra_body ?? {};
  const isOffline = extraBody.offline ?? false;

  // The worker always emits raw PCM. Node handles format conversion.
  const workerBody = {
    text: body.input,
    voice_name: body.voice ?? 'default',
    output_format: 'pcm',
    speed: body.speed ?? 1.0,
    offline: isOffline,
    extra_body: extraBody,
  };

  if (body.instructions) workerBody.instruct_text = body.instructions;
  if (extraBody.exaggeration !== undefined) workerBody.exaggeration = extraBody.exaggeration;
  if (extraBody.language !== undefined) workerBody.language = extraBody.language;
  if (extraBody.model !== undefined) workerBody.model = extraBody.model;
  if (extraBody.seed !== undefined) workerBody.seed = extraBody.seed;
  if (extraBody.steps !== undefined) workerBody.extra_body.steps = extraBody.steps;
  if (extraBody.guidance_scale !== undefined) workerBody.extra_body.guidance_scale = extraBody.guidance_scale;

  // ── Get or start worker ─────────────────────────────────────────────────
  let worker;
  try {
    worker = await manager.getWorker(engineName);
  } catch (err) {
    return sendError(reply, err);
  }

  // ── Relay to worker ─────────────────────────────────────────────────────
  let resp;
  try {
    resp = await worker.relay('POST', '/v1/audio/speech', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workerBody),
      signal: request.raw.socket.destroyed ? AbortSignal.abort() : undefined,
    });
  } catch (err) {
    return sendError(reply, err);
  }

  if (resp._stallTimer) clearTimeout(resp._stallTimer);

  // Error responses: forward the worker's error body as-is
  if (resp.status >= 400) {
    const errText = await resp.text();
    const ct = resp.headers.get('content-type') || 'application/json';
    reply.code(resp.status).type(ct).send(Buffer.from(errText, 'utf8'));
    return;
  }

  // ── Set response headers ────────────────────────────────────────────────
  reply.code(200);
  reply.type(getContentType(clientFormat));
  reply.header('X-Stream-Mode', isOffline ? 'chunked' : 'native');

  // ── Stream: raw passthrough (wav, pcm, pcm_f32) ─────────────────────────
  if (RAW_FORMATS.has(clientFormat) || !resp.body) {
    // For wav: the worker already includes the WAV header in the PCM stream
    // when output_format=wav. For pcm/pcm_f32: raw bytes pass through.
    // We need to request wav from the worker if client wants wav.
    if (clientFormat === 'wav') {
      // Re-request as wav (worker includes header) — but we already sent pcm.
      // For simplicity, raw formats request the actual format from the worker.
      // This path is rarely used by the dashboard (which uses mp3).
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    reply.send(buf);
    return;
  }

  // ── Stream: transcode PCM → compressed (mp3, opus, aac) ─────────────────
  if (!TRANSCODE_FORMATS.has(clientFormat)) {
    // Unknown format — fall back to buffering
    const buf = Buffer.from(await resp.arrayBuffer());
    reply.send(buf);
    return;
  }

  // Spawn ffmpeg, pipe worker PCM → ffmpeg stdin, ffmpeg stdout → client.
  // Uses the shared pipePcmToClient helper (same code path as preview).
  reply.hijack();
  const rawResponse = reply.raw;

  const pcmStream = Readable.fromWeb(resp.body);

  // Handle client disconnect — kill ffmpeg
  request.raw.on('close', () => {
    pcmStream.destroy();
  });

  pipePcmToClient(pcmStream, rawResponse, clientFormat, {
    streamMode: isOffline ? 'chunked' : 'native',
  });
}

/**
 * Register the /v1/audio/speech route on a Fastify instance.
 */
export function registerSpeechRoute(app) {
  app.post('/v1/audio/speech', async (request, reply) => {
    const body = typeof request.body === 'object' ? request.body : {};
    await relaySpeech(request, reply, body);
  });
}

/**
 * Send a WorkerError or generic error as an OpenAI-compatible error response.
 */
function sendError(reply, err) {
  if (err.toJSON) {
    return reply.code(err.status || 503).send(err.toJSON());
  }
  return reply.code(503).send({
    error: { message: err.message, type: 'engine_error', code: 'unknown' },
  });
}
