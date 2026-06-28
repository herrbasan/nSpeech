/**
 * STT and forced alignment proxy — forwards to nVoice service.
 *
 * Routes:
 *   POST /v1/audio/transcriptions — speech-to-text (OpenAI-compatible)
 *   POST /v1/audio/align          — forced alignment (nSpeech extension)
 *
 * Both are multipart endpoints. Node forwards the raw stream to nVoice
 * and streams the response back unchanged. Node is transport-only.
 *
 * nVoice URL comes from config.nvoiceUrl. If not configured, returns 503.
 */
import { config } from '../config.js';

/**
 * Register STT and alignment routes on a Fastify instance.
 */
export function registerSttRoutes(app) {

  // ── POST /v1/audio/transcriptions ────────────────────────────────────────

  app.post('/v1/audio/transcriptions', {
    config: { rawBody: false },
  }, async (request, reply) => {
    await proxyToNVoice(request, reply, '/v1/audio/transcriptions');
  });

  // ── POST /v1/audio/align ─────────────────────────────────────────────────

  app.post('/v1/audio/align', {
    config: { rawBody: false },
  }, async (request, reply) => {
    await proxyToNVoice(request, reply, '/v1/audio/align');
  });
}

/**
 * Forward a raw multipart request to nVoice and stream the response back.
 */
async function proxyToNVoice(request, reply, path) {
  if (!config.nvoiceUrl) {
    return reply.code(503).send({
      error: {
        message: 'nVoice URL not configured. Set nvoice_url in config.json.',
        type: 'service_unavailable',
        code: 'nvoice_not_configured',
      },
    });
  }

  const url = `${config.nvoiceUrl}${path}`;
  const contentType = request.headers['content-type'];

  try {
    // Forward the buffered multipart body set by Fastify's parser.
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(request.body || '');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      signal: AbortSignal.timeout(120_000),  // 2 min timeout for long audio
    });

    // Forward status and content-type
    reply.code(resp.status);
    const respContentType = resp.headers.get('content-type');
    if (respContentType) reply.type(respContentType);

    if (resp.body) {
      const buf = Buffer.from(await resp.arrayBuffer());
      reply.send(buf);
    } else {
      reply.send();
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return reply.code(504).send({
        error: {
          message: 'nVoice request timed out',
          type: 'service_unavailable',
          code: 'nvoice_timeout',
        },
      });
    }
    return reply.code(502).send({
      error: {
        message: `nVoice proxy error: ${err.message}`,
        type: 'engine_error',
        code: 'nvoice_error',
      },
    });
  }
}
