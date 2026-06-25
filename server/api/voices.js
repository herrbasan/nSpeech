/**
 * Voice management routes — /v1/voices/*
 *
 * All routes forward to the active engine worker. Node may normalize
 * response shapes for OpenAI compatibility.
 *
 * Routes:
 *   GET    /v1/voices           — list voices
 *   POST   /v1/voices/clone     — persist a cloned voice (multipart)
 *   POST   /v1/voices/preview   — temporary clone + preview audio (multipart)
 *   POST   /v1/voices/mix       — blend two voices (JSON)
 *   DELETE /v1/voices/:voiceId  — delete a voice
 */
import { manager } from '../engine/manager.js';

/**
 * Register all voice management routes on a Fastify instance.
 */
export function registerVoiceRoutes(app) {

  // ── GET /v1/voices ───────────────────────────────────────────────────────

  app.get('/v1/voices', async (request, reply) => {
    const engineName = request.query.engine || manager.currentEngine;

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const resp = await worker.relay('GET', '/v1/voices');
      const data = await resp.json();

      // Normalize: ensure each voice has voice_id and engine fields
      if (data.voices) {
        data.voices = data.voices.map(v => ({
          voice_id: v.voice_id ?? v.name,
          name: v.name ?? v.voice_id,
          category: v.category ?? 'cloned',
          engine: v.engine ?? engineName,
          ...v,  // preserve any extra fields
        }));
      }

      reply.code(resp.status).send(data);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── POST /v1/voices/clone ────────────────────────────────────────────────

  app.post('/v1/voices/clone', {
    config: { rawBody: false },
  }, async (request, reply) => {
    const engineName = request.query.engine || manager.currentEngine;

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const contentType = request.headers['content-type'];
      const resp = await worker.relay('POST', '/v1/voices/clone', {
        headers: { 'content-type': contentType },
        body: request.raw,
      });

      if (resp._stallTimer) clearTimeout(resp._stallTimer);
      const text = await resp.text();
      reply.code(resp.status).send(text);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── POST /v1/voices/preview ──────────────────────────────────────────────

  app.post('/v1/voices/preview', {
    config: { rawBody: false },
  }, async (request, reply) => {
    const engineName = request.query.engine || manager.currentEngine;

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const contentType = request.headers['content-type'];
      const resp = await worker.relay('POST', '/v1/voices/preview', {
        headers: { 'content-type': contentType },
        body: request.raw,
      });

      reply.code(resp.status);
      if (resp.headers.get('content-type')) reply.type(resp.headers.get('content-type'));

      if (resp._stallTimer) clearTimeout(resp._stallTimer);

      if (resp.body) {
        const buf = Buffer.from(await resp.arrayBuffer());
        reply.send(buf);
      } else {
        reply.send();
      }
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── POST /v1/voices/mix ──────────────────────────────────────────────────

  app.post('/v1/voices/mix', async (request, reply) => {
    const engineName = manager.currentEngine;

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const resp = await worker.relay('POST', '/v1/voices/mix', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      });

      if (resp._stallTimer) clearTimeout(resp._stallTimer);
      const text = await resp.text();
      reply.code(resp.status).send(text);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── DELETE /v1/voices/:voiceId ───────────────────────────────────────────

  app.delete('/v1/voices/:voiceId', async (request, reply) => {
    const engineName = request.query.engine || manager.currentEngine;
    const { voiceId } = request.params;

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const resp = await worker.relay('DELETE', `/v1/voices/${encodeURIComponent(voiceId)}`);

      if (resp._stallTimer) clearTimeout(resp._stallTimer);
      const text = await resp.text();
      reply.code(resp.status).send(text);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

function sendError(reply, err) {
  if (err.toJSON) {
    return reply.code(err.status || 503).send(err.toJSON());
  }
  return reply.code(503).send({
    error: { message: err.message, type: 'engine_error', code: 'unknown' },
  });
}
