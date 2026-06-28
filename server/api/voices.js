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
import { Readable } from 'node:stream';
import { pipePcmToClient } from '../transcode.js';

/**
 * Register all voice management routes on a Fastify instance.
 */
export function registerVoiceRoutes(app) {

  // ── GET /v1/voices & /voices ─────────────────────────────────────────────

  const getVoicesHandler = async (request, reply) => {
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
          voice_type: v.voice_type ?? v.category ?? 'cloned',
          engine: v.engine ?? engineName,
          ...v,  // preserve any extra fields
        }));
      }

      reply.code(resp.status).send(data);
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.get('/v1/voices', getVoicesHandler);

  // ── POST /v1/voices/clone ──────────────────────────────────────────────

  const cloneVoiceHandler = async (request, reply) => {
    const engineName = request.query.engine || manager.currentEngine;

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const contentType = request.headers['content-type'];
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(request.body || '');
      const resp = await worker.relay('POST', '/v1/voices/clone', {
        headers: { 'content-type': contentType },
        body,
      });

      if (resp._stallTimer) clearTimeout(resp._stallTimer);
      const text = await resp.text();
      reply.code(resp.status).send(text);
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.post('/v1/voices/clone', { config: { rawBody: false } }, cloneVoiceHandler);

  // ── POST /v1/voices/preview ────────────────────────────────────────────

  const previewVoiceHandler = async (request, reply) => {
    const engineName = request.query.engine || manager.currentEngine;

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      const contentType = request.headers['content-type'];
      // Fastify's addContentTypeParser (registered in server/index.js) gives
      // us the buffered multipart body as a Buffer on request.body. We forward
      // it to the worker, which does the actual multipart parsing via FastAPI.
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(request.body || '');
      const resp = await worker.relay('POST', '/v1/voices/preview', {
        headers: { 'content-type': contentType },
        body,
      });

      if (resp._stallTimer) clearTimeout(resp._stallTimer);

      // Error responses: forward the worker's error body as-is
      if (resp.status >= 400 || !resp.body) {
        const errBuf = resp.body ? Buffer.from(await resp.arrayBuffer()) : Buffer.alloc(0);
        const ct = resp.headers.get('content-type') || 'application/json';
        return reply.code(resp.status).type(ct).send(errBuf);
      }

      // Worker returns raw PCM (s16le, 24kHz, mono). Transcode to MP3 via
      // ffmpeg — same path as /v1/audio/speech. The browser's MediaSource
      // needs audio/mpeg; raw PCM or PyAV-encoded opus won't play.
      reply.hijack();
      const rawResponse = reply.raw;
      const pcmStream = Readable.fromWeb(resp.body);

      request.raw.on('close', () => {
        pcmStream.destroy();
      });

      pipePcmToClient(pcmStream, rawResponse, 'mp3', { streamMode: 'native' });
    } catch (err) {
      sendError(reply, err);
    }
  };

  app.post('/v1/voices/preview', { config: { rawBody: false } }, previewVoiceHandler);

  // ── POST /v1/voices/mix ────────────────────────────────────────────────

  const mixVoicesHandler = async (request, reply) => {
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
  };

  app.post('/v1/voices/mix', mixVoicesHandler);

  // ── DELETE /v1/voices/:voiceId ─────────────────────────────────────────

  const deleteVoiceHandler = async (request, reply) => {
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
