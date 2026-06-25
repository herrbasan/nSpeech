/**
 * POST /v1/audio/speech/clone — One-shot TTS from an uploaded voice sample.
 *
 * Clones a voice from an uploaded audio sample and immediately synthesizes
 * text in that voice. The voice is NOT persisted.
 *
 * Implementation: forwards the raw multipart body to the worker's
 * /v1/voices/preview endpoint, which already does clone + generate.
 * The worker returns audio bytes directly.
 *
 * To avoid Fastify multipart consuming the body before we can forward it,
 * this route is registered with `config: { rawBody: false }` and reads
 * the engine from the query string instead of the multipart body.
 */
import { manager } from '../engine/manager.js';
import { resolveEngine, getContentType, normalizeFormat } from './formats.js';

/**
 * Register the /v1/audio/speech/clone route on a Fastify instance.
 *
 * The engine is resolved from ?engine= or ?model= query param since we
 * can't parse the multipart body without consuming the stream.
 */
export function registerSpeechCloneRoute(app) {
  app.post('/v1/audio/speech/clone', {
    // Bypass Fastify multipart body parser — we forward the raw stream
    config: {
      rawBody: false,
    },
  }, async (request, reply) => {
    const engineName = resolveEngine(request.query.model) ||
                       request.query.engine ||
                       manager.currentEngine;
    const outputFormat = normalizeFormat(request.query.response_format);

    let worker;
    try {
      worker = await manager.getWorker(engineName);
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      // Forward the raw multipart stream to the worker's preview endpoint
      const contentType = request.headers['content-type'];
      const resp = await worker.relay('POST', '/v1/voices/preview', {
        headers: { 'content-type': contentType },
        body: request.raw,
      });

      reply.code(resp.status);
      reply.type(getContentType(outputFormat));
      reply.header('X-Stream-Mode', 'chunked');

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
}

function sendError(reply, err) {
  if (err.toJSON) {
    return reply.code(err.status || 503).send(err.toJSON());
  }
  return reply.code(503).send({
    error: { message: err.message, type: 'engine_error', code: 'unknown' },
  });
}
