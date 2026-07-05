/**
 * Voice management routes — /v1/voices/*
 *
 * All routes resolve the engine via manager.getEngine() and call engine
 * methods directly. Works identically for Python workers and cloud adapters.
 *
 * Routes:
 *   GET    /v1/voices           — list voices
 *   POST   /v1/voices/clone     — persist a cloned voice (multipart)
 *   POST   /v1/voices/preview   — temporary clone + preview audio (multipart)
 *   POST   /v1/voices/mix       — blend two voices (JSON)
 *   DELETE /v1/voices/:voiceId  — delete a voice
 */
import { manager } from '../engine/manager.js';
import { pipePcmToClient } from '../transcode.js';
import { logger } from '../logger.js';
import { parseMultipart } from './multipart.js';

/**
 * Register all voice management routes on a Fastify instance.
 */
export function registerVoiceRoutes(app) {

  // ── GET /v1/voices ────────────────────────────────────────────────────────

  const getVoicesHandler = async (request, reply) => {
    const model = request.query.engine || request.query.model;

    let engine;
    try {
      const resolved = await manager.getEngine(model);
      engine = resolved.engine;
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const data = await engine.listVoices();

      // Normalize: ensure each voice has voice_id and engine fields
      if (data.voices) {
        data.voices = data.voices.map(v => ({
          voice_id: v.voice_id ?? v.name,
          name: v.name ?? v.voice_id,
          category: v.category ?? 'cloned',
          voice_type: v.voice_type ?? v.category ?? 'cloned',
          engine: v.engine ?? (typeof engine.engineName === 'string' ? engine.engineName : 'cloud'),
          ...v,
        }));
      }

      reply.send(data);
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.get('/v1/voices', getVoicesHandler);

  // ── POST /v1/voices/clone ─────────────────────────────────────────────────

  const cloneVoiceHandler = async (request, reply) => {
    const model = request.query.engine || request.query.model;

    let engine;
    try {
      const resolved = await manager.getEngine(model);
      engine = resolved.engine;
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      // Fastify addContentTypeParser gives us the raw multipart buffer.
      // Parse the name and audio fields from the body.
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(request.body || '');

      // Simple multipart parse — just get name + audio
      const contentType = request.headers['content-type'] || '';
      const data = parseMultipart(body, contentType);

      const result = await engine.cloneVoice({
        audio: data.audio,
        voice_name: data.name || data.voice_name || `clone_${Date.now()}`,
        prompt_text: data.prompt_text,
        model: data.model,
      });

      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.post('/v1/voices/clone', { config: { rawBody: false } }, cloneVoiceHandler);

  // ── POST /v1/voices/preview ───────────────────────────────────────────────

  const previewVoiceHandler = async (request, reply) => {
    const model = request.query.engine || request.query.model;

    let engine;
    try {
      const resolved = await manager.getEngine(model);
      engine = resolved.engine;
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(request.body || '');

      const contentType = request.headers['content-type'] || '';
      const data = parseMultipart(body, contentType);

      logger.info('preview multipart parsed', {
        hasAudio: !!data.audio,
        audioLen: data.audio?.length || 0,
        voiceName: data.name || data.voice_name,
        keys: Object.keys(data),
      });

      const result = await engine.previewVoice({
        audio: data.audio,
        voice_name: data.name || data.voice_name,
        prompt_text: data.prompt_text,
        preview_text: data.test_phrase || data.preview_text,
        model: data.model,
      });

      // Engine returns { pcmStream, extraHeaders }. Transcode to MP3.
      reply.hijack();
      const rawResponse = reply.raw;

      const extraHeaders = result.extraHeaders || {};
      request.raw.on('close', () => {
        result.pcmStream.destroy();
      });

      pipePcmToClient(result.pcmStream, rawResponse, 'mp3', {
        streamMode: 'native',
        extraHeaders,
      });
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.post('/v1/voices/preview', { config: { rawBody: false } }, previewVoiceHandler);

  // ── POST /v1/voices/mix ───────────────────────────────────────────────────

  const mixVoicesHandler = async (request, reply) => {
    const model = manager.currentEngine;

    let engine;
    try {
      engine = await manager.getEngine(model);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const result = await engine.mixVoices({
        name: request.body.name,
        voice_a: request.body.voice_a,
        voice_b: request.body.voice_b,
        ratio: request.body.ratio ?? 0.5,
      });
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.post('/v1/voices/mix', mixVoicesHandler);

  // ── DELETE /v1/voices/:voiceId ────────────────────────────────────────────

  const deleteVoiceHandler = async (request, reply) => {
    const model = request.query.engine || manager.currentEngine;
    const { voiceId } = request.params;

    let engine;
    try {
      const resolved = await manager.getEngine(model);
      engine = resolved.engine;
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const result = await engine.deleteVoice(voiceId);
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.delete('/v1/voices/:voiceId', deleteVoiceHandler);
}

function sendError(reply, err) {
  if (err.toJSON) {
    return reply.code(err.status || 503).send(err.toJSON());
  }
  return reply.code(503).send({
    error: { message: err.message, type: 'engine_error', code: 'unknown' },
  });
}
