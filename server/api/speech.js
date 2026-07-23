/**
 * POST /v1/audio/speech — OpenAI-compatible TTS endpoint.
 *
 * Validates the OpenAI request, resolves the engine (local Python worker or
 * cloud adapter), calls engine.generatePcmStream(), and transcodes the raw
 * PCM stream to the client's requested format via ffmpeg.
 *
 * The engine always emits raw s16le 24kHz mono PCM — regardless of whether
 * it's a Python worker or cloud adapter. Node owns all format transcoding.
 */
import { manager } from '../engine/manager.js';
import { WorkerError } from '../engine/worker.js';
import { getContentType, normalizeFormat } from './formats.js';
import { logger } from '../logger.js';
import { pipePcmToClient } from '../transcode.js';
import * as presets from '../presets.js';

const log = logger.child('speech');

/** Formats that need ffmpeg transcoding (compressed). */
const TRANSCODE_FORMATS = new Set(['mp3', 'opus', 'aac']);

/** Formats that pass through raw (no transcoding needed). */
const RAW_FORMATS = new Set(['wav', 'pcm', 'pcm_f32']);

/**
 * Core TTS relay — shared by POST /v1/audio/speech.
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

  const clientFormat = normalizeFormat(body.response_format);
  const extraBody = body.extra_body ?? {};

  log.info('speech request', {
    model: body.model,
    inputLen: (body.input || '').length,
    inputPreview: (body.input || '').slice(0, 200) + ((body.input || '').length > 200 ? '...' : ''),
    voice: body.voice,
    format: clientFormat,
  });

  // ── Resolve engine ───────────────────────────────────────────────────────
  let engine, subModel;
  try {
    const resolved = await manager.getEngine(body.model);
    engine = resolved.engine;
    subModel = extraBody.model ?? resolved.model;
  } catch (err) {
    return sendError(reply, err);
  }

  // ── Resolve preset (Node-managed voice configuration) ──────────────────
  let voiceName = body.voice ?? 'default';
  let instructions = body.instructions;
  let speed = body.speed ?? 1.0;
  const engineName = body.model || manager.currentEngine;
  if (engineName) {
    const resolved = presets.lookup(engineName, voiceName);
    if (resolved) {
      log.info('preset resolved', { engine: engineName, preset: voiceName, to: resolved.voice });
      voiceName = resolved.voice;
      if (resolved.instructions) instructions = resolved.instructions;
      if (resolved.speed != null) speed = resolved.speed;
      if (resolved.extra_body) Object.assign(extraBody, resolved.extra_body);
    }
  }

  // ── Generate PCM stream ─────────────────────────────────────────────────
  let pcmStream;
  try {
    pcmStream = await engine.generatePcmStream({
      text: body.input,
      voice_name: voiceName,
      speed,
      instruct_text: instructions,
      extra_body: extraBody,
      model: subModel,
    });
  } catch (err) {
    return sendError(reply, err);
  }

  // ── Set response headers ────────────────────────────────────────────────
  const isBatch = extraBody.batch ?? false;
  reply.code(200);
  reply.type(getContentType(clientFormat));
  reply.header('X-Stream-Mode', isBatch ? 'chunked' : 'native');

  // ── Raw passthrough (wav, pcm, pcm_f32) ─────────────────────────────────
  if (RAW_FORMATS.has(clientFormat)) {
    const chunks = [];
    for await (const chunk of pcmStream) {
      chunks.push(chunk);
    }
    reply.send(Buffer.concat(chunks));
    return;
  }

  // ── Transcode PCM → compressed (mp3, opus, aac) ─────────────────────────
  if (!TRANSCODE_FORMATS.has(clientFormat)) {
    const chunks = [];
    for await (const chunk of pcmStream) {
      chunks.push(chunk);
    }
    reply.send(Buffer.concat(chunks));
    return;
  }

  reply.hijack();
  const rawResponse = reply.raw;

  request.raw.on('close', () => {
    pcmStream.destroy();
  });

  // Per-request normalization override (optional, defaults to config.transcode.normalizationPeak)
  const normalizePeak = extraBody.normalize?.peak;

  pipePcmToClient(pcmStream, rawResponse, clientFormat, {
    streamMode: isBatch ? 'chunked' : 'native',
    normalizePeak,
  });
}

/**
 * Register the /v1/audio/speech route on a Fastify instance.
 */
export function registerSpeechRoute(app) {
  // POST — standard OpenAI-compatible JSON body
  app.post('/v1/audio/speech', async (request, reply) => {
    const body = typeof request.body === 'object' ? request.body : {};
    await relaySpeech(request, reply, body);
  });

  // GET — query-param convenience for simple clients (chat app, browser fetch)
  app.get('/v1/audio/speech', async (request, reply) => {
    const q = request.query;
    const body = {
      model: q.model || undefined,
      input: q.input || '',
      voice: q.voice || undefined,
      response_format: q.response_format || undefined,
      speed: q.speed ? parseFloat(q.speed) : 1.0,
    };
    await relaySpeech(request, reply, body);
  });
}

/**
 * Send a WorkerError or generic error as an OpenAI-compatible error response.
 * Honors err.status / err.type / err.code when present.
 */
function sendError(reply, err) {
  if (err.toJSON) {
    return reply.code(err.status || 503).send(err.toJSON());
  }

  const status = err.status || 503;
  const type = err.type || 'engine_error';
  const code = err.code || 'unknown';

  return reply.code(status).send({
    error: { message: err.message, type, code },
  });
}
