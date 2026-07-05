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
import { WorkerProcess } from '../engine/worker.js';
import { Readable } from 'node:stream';
import { normalizeFormat } from './formats.js';
import { parseMultipart } from './multipart.js';
import { pipePcmToClient } from '../transcode.js';

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
    const model = request.query.model || request.query.engine || null;
    const outputFormat = normalizeFormat(request.query.response_format);

    let engine;
    try {
      const resolved = await manager.getEngine(model);
      engine = resolved.engine;
    } catch (err) {
      return sendError(reply, err);
    }

    try {
      // ── Cloud adapter: use previewVoice() ──────────────────────────────
      if (!(engine instanceof WorkerProcess)) {
        const contentType = request.headers['content-type'];
        const body = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(request.body || '');
        const data = parseMultipart(body, contentType);

        const result = await engine.previewVoice({
          audio: data.audio,
          voice_name: data.name || data.voice_name,
          prompt_text: data.prompt_text,
          preview_text: data.test_phrase || data.preview_text,
        });

        reply.hijack();
        const rawResponse = reply.raw;
        request.raw.on('close', () => { result.pcmStream.destroy(); });
        pipePcmToClient(result.pcmStream, rawResponse, outputFormat, { streamMode: 'chunked' });
        return;
      }

      // ── Local worker: forward multipart to worker's preview endpoint ───
      const contentType = request.headers['content-type'];
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(request.body || '');
      const resp = await engine.relay('POST', '/v1/voices/preview', {
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

      // Worker returns raw PCM — transcode to the client's requested format.
      reply.hijack();
      const rawResponse = reply.raw;
      const pcmStream = Readable.fromWeb(resp.body);

      request.raw.on('close', () => {
        pcmStream.destroy();
      });

      pipePcmToClient(pcmStream, rawResponse, outputFormat, { streamMode: 'chunked' });
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
