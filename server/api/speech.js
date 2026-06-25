/**
 * POST /v1/audio/speech — OpenAI-compatible TTS endpoint.
 *
 * Translates OpenAI request fields to engine-native fields and forwards
 * to the engine worker. Node is transport-only — no transcoding.
 *
 * OpenAI → Worker field mapping:
 *   input           → text
 *   voice           → voice_name
 *   response_format → output_format
 *   speed           → speed
 *   instructions    → instruct_text
 *   extra_body      → merged into worker body
 */
import { manager } from '../engine/manager.js';
import { WorkerError } from '../engine/worker.js';
import { getContentType, normalizeFormat, resolveEngine } from './formats.js';

/**
 * Register the /v1/audio/speech route on a Fastify instance.
 */
export function registerSpeechRoute(app) {
  app.post('/v1/audio/speech', async (request, reply) => {
    const body = typeof request.body === 'object' ? request.body : {};

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
    const outputFormat = normalizeFormat(body.response_format);
    const extraBody = body.extra_body ?? {};

    const workerBody = {
      text: body.input,
      voice_name: body.voice ?? 'default',
      output_format: outputFormat,
      speed: body.speed ?? 1.0,
      offline: extraBody.offline ?? false,
      extra_body: extraBody,
    };

    // Map instructions → instruct_text (engine-specific style)
    if (body.instructions) {
      workerBody.instruct_text = body.instructions;
    }

    // Pass through engine-specific fields from extra_body
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
    try {
      const resp = await worker.relay('POST', '/v1/audio/speech', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(workerBody),
        signal: request.raw.socket.destroyed ? AbortSignal.abort() : undefined,
      });

      // Forward response
      reply.code(resp.status);

      // Set Content-Type from the requested format (authoritative)
      reply.type(getContentType(outputFormat));

      // Set X-Stream-Mode header
      const isStreaming = !(extraBody.offline ?? false);
      reply.header('X-Stream-Mode', isStreaming ? 'native' : 'chunked');

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
