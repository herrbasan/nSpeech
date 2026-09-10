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
 *   POST   /v1/voices/preset    — create/update a voice preset (JSON)
 *   DELETE /v1/voices/:voiceId  — delete a voice (or preset)
 */
import { manager } from '../engine/manager.js';
import { pipePcmToClient } from '../transcode.js';
import { logger } from '../logger.js';
import { parseMultipart } from './multipart.js';
import * as presets from '../presets.js';
import * as voiceCache from '../voice-cache.js';

/**
 * Register all voice management routes on a Fastify instance.
 */
export function registerVoiceRoutes(app) {

  // ── GET /v1/voices ────────────────────────────────────────────────────────

  const getVoicesHandler = async (request, reply) => {
    const model = request.query.engine || request.query.model;
    const engineName = voiceCache.engineKey(model, manager.currentEngine);

    // Cached path: serve from the server-side snapshot. It reads the engine's
    // voice directory directly and never spawns a worker, so a voice listing
    // can't trigger a GPU load. An engine this cache doesn't know falls
    // through to getEngine() so unknown names still fail with a 404.
    let engineData;
    try {
      if (voiceCache.isCacheable(model, manager.currentEngine)) {
        engineData = await voiceCache.get(engineName);
      } else {
        // Voice listing may target dashboard-only (api_hidden) engines — the
        // dashboard's per-engine voices pages need their engine's list even
        // when it's not current. Generation stays guarded (speech relay).
        manager._allowHiddenLookup = true;
        try {
          const resolved = await manager.getEngine(model);
          engineData = await resolved.engine.listVoices();
        } finally {
          manager._allowHiddenLookup = false;
        }
      }
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      // Clone the list so we don't mutate the engine's internal cache
      // (cloud adapters cache the voices array by reference).
      const data = { voices: engineData.voices ? [...engineData.voices] : [] };

      // Normalize: ensure each voice has voice_id and engine fields
      if (data.voices) {
        data.voices = data.voices.map(v => ({
          voice_id: v.voice_id ?? v.name,
          name: v.name ?? v.voice_id,
          category: v.category ?? 'cloned',
          voice_type: v.voice_type ?? v.category ?? 'cloned',
          engine: v.engine ?? engineName,
          ...v,
        }));
      } else {
        data.voices = [];
      }

      // Merge Node-managed presets into the voice list. Presets are keyed by
      // engine name — engineKey() normalizes model slugs (cloud aliases, bare
      // prefixes) to the same name the preset store uses.
      data.voices.push(...presets.toVoiceList(engineName));

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

      await voiceCache.invalidate(voiceCache.engineKey(model, manager.currentEngine));
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
    const model = request.query.engine || request.query.model || manager.currentEngine;

    let engine;
    try {
      const resolved = await manager.getEngine(model);
      engine = resolved.engine;
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
      await voiceCache.invalidate(voiceCache.engineKey(model, manager.currentEngine));
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.post('/v1/voices/mix', mixVoicesHandler);

  // ── POST /v1/voices/preset ────────────────────────────────────────────────

  const presetHandler = async (request, reply) => {
    const { engine: engineName, id, name, voice, instructions, speed, extra_body } = request.body || {};

    if (!engineName || !id || !name || !voice) {
      return reply.code(400).send({
        error: {
          message: 'Missing required fields: engine, id, name, voice',
          type: 'invalid_request_error',
          code: 'missing_fields',
        },
      });
    }

    try {
      const result = presets.set(engineName, { id, name, voice, instructions, speed, extra_body });
      await voiceCache.invalidate(engineName);
      reply.send({
        voice_id: result.id,
        name: result.name,
        voice_type: 'preset',
        engine: engineName,
        base_voice: result.voice,
        ...(result.instructions ? { instructions: result.instructions } : {}),
        ...(result.speed != null ? { speed: result.speed } : {}),
      });
    } catch (err) {
      reply.code(500).send({
        error: { message: err.message, type: 'engine_error', code: 'preset_save_failed' },
      });
    }
  };

  app.post('/v1/voices/preset', presetHandler);

  // ── DELETE /v1/voices/:voiceId ────────────────────────────────────────────

  const deleteVoiceHandler = async (request, reply) => {
    const model = request.query.engine || manager.currentEngine;
    const { voiceId } = request.params;

    // Check Node-managed presets first — if the ID matches a preset,
    // delete it locally without involving the engine.
    const engineName = model && typeof model === 'string' ? model : manager.currentEngine;
    if (presets.remove(engineName, voiceId)) {
      await voiceCache.invalidate(engineName);
      return reply.send({ deleted: true });
    }

    let engine;
    try {
      const resolved = await manager.getEngine(model);
      engine = resolved.engine;
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const result = await engine.deleteVoice(voiceId);
      await voiceCache.invalidate(voiceCache.engineKey(model, manager.currentEngine));
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
