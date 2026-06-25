/**
 * Engine switch endpoint with SSE progress events.
 *
 * POST /v1/admin/engine
 *
 * Request body: {"engine": "dots"}
 * Response: SSE stream of status events
 *
 * Events:
 *   event: status
 *   data: {"stage": "unload_start", "engine": "kokoro"}
 *
 *   event: status
 *   data: {"stage": "unload_done", "engine": "kokoro"}
 *
 *   event: status
 *   data: {"stage": "load_start", "engine": "dots"}
 *
 *   event: status
 *   data: {"stage": "load_done", "engine": "dots"}
 *
 *   event: result
 *   data: {"engine": "dots", "status": "switched"}
 *
 * Or on error:
 *   event: error
 *   data: {"error": {"message": "...", "type": "...", "code": "..."}}
 *
 * Behavior:
 * - Serialized via manager mutex (concurrent switches queue).
 * - If current engine has in-flight requests, returns 409 (before SSE starts).
 * - In-flight requests to old engine are killed on switch.
 */
import { manager } from '../engine/manager.js';
import { getEntry } from '../engine/registry.js';

/**
 * Register the engine switch route on a Fastify instance.
 */
export function registerAdminRoutes(app) {

  // ── POST /v1/admin/engine — switch engine with SSE progress ──────────────

  app.post('/v1/admin/engine', async (request, reply) => {
    const body = typeof request.body === 'object' ? request.body : {};
    const engineName = body.engine;

    if (!engineName) {
      return reply.code(400).send({
        error: {
          message: "Missing required field: 'engine'",
          type: 'invalid_request_error',
          code: 'missing_engine',
          param: 'engine',
        },
      });
    }

    const entry = getEntry(engineName);
    if (!entry) {
      return reply.code(404).send({
        error: {
          message: `Unknown engine: ${engineName}`,
          type: 'invalid_request_error',
          code: 'engine_not_found',
          param: 'engine',
        },
      });
    }

    // Quick pre-check: if current engine is busy, fail fast before SSE
    const currentWorker = manager.workers.get(manager.currentEngine);
    if (currentWorker && currentWorker.inFlight > 0) {
      return reply.code(409).send({
        error: {
          message: `Cannot switch: ${currentWorker.inFlight} request(s) active on ${manager.currentEngine}`,
          type: 'invalid_request_error',
          code: 'engine_busy',
        },
      });
    }

    // Already active?
    if (manager.currentEngine === engineName) {
      const worker = manager.workers.get(engineName);
      if (worker && worker.state === 'ready') {
        return reply.code(200).send({ engine: engineName, status: 'already_active' });
      }
    }

    // ── SSE stream ──────────────────────────────────────────────────────────

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    /** Send an SSE event. */
    function sendEvent(event, data) {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const result = await manager.switchEngine(engineName, {
        onStatus: (stage, engine) => {
          sendEvent('status', { stage, engine });
        },
      });

      sendEvent('result', result);
    } catch (err) {
      const errorObj = err.toJSON ? err.toJSON() : {
        error: { message: err.message, type: 'engine_error', code: 'unknown' },
      };
      sendEvent('error', errorObj);
    }

    reply.raw.end();
  });

  // ── GET /v1/admin/engines — list available engines ───────────────────────

  app.get('/v1/admin/engines', async () => {
    const { listEngines, getEntry, venvExists } = await import('../engine/registry.js');
    const engines = listEngines().map(name => {
      const entry = getEntry(name);
      return {
        name,
        gpu: entry.gpu,
        venv_exists: venvExists(name),
        is_current: manager.currentEngine === name,
        is_loaded: manager.workers.has(name) && manager.workers.get(name).state === 'ready',
      };
    });
    return { engines, current: manager.currentEngine };
  });
}
