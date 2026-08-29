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
import { resolveCloud } from '../cloud/registry.js';
import { subscribe, getHistory } from '../events.js';

/**
 * Register admin routes on a Fastify instance.
 */
export function registerAdminRoutes(app) {

  // ── GET /v1/admin/events — live event stream (SSE) ───────────────────────

  app.get('/v1/admin/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Replay recent history on connect
    for (const event of getHistory()) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Subscribe to live events
    const unsub = subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Cleanup on disconnect
    request.raw.on('close', () => {
      unsub();
    });
  });

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

    // ── Resolve engine: cloud or local ────────────────────────────────────────
    const cloud = resolveCloud(engineName);

    if (cloud) {
      // Cloud engines — stateless, no worker lifecycle. Still need SSE
      // because the dashboard expects event streams for every switch.
      const health = cloud.adapter.health();
      if (health.status === 'dead') {
        return reply.code(503).send({
          error: {
            message: health.error || 'Cloud adapter is not available',
            type: 'service_unavailable',
            code: 'cloud_unavailable',
          },
        });
      }

      // Check busy local workers (won't block cloud, but let the user know)
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

      // Emit SSE with a single status event, then result
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      function sendEvent(event, data) {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      }

      // If a local engine is currently loaded, unload it before switching
      // to a cloud engine so we don't waste VRAM / leave workers running.
      const oldLocal = manager.currentEngine;
      if (oldLocal) {
        const oldWorker = manager.workers.get(oldLocal);
        if (oldWorker) {
          sendEvent('status', { stage: 'unload_start', engine: oldLocal });
          try {
            await manager.unload(oldLocal);
            sendEvent('status', { stage: 'unload_done', engine: oldLocal });
          } catch (err) {
            sendEvent('error', { error: { message: err.message, type: 'engine_error', code: err.code || 'unknown' } });
            reply.raw.end();
            return;
          }
        }
      }

      sendEvent('status', { stage: 'switch_done', engine: engineName });
      manager.setCurrentEngine(engineName);
      sendEvent('result', { engine: engineName, status: 'switched' });
      reply.raw.end();
      return;
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

  // ── GET /v1/models — OpenAI-style list of usable models ──────────────────
  //
  // Everything the client can pass as `model` right now WITHOUT switching
  // engines:
  //   - "nspeech" → the current local engine
  //   - every resident local engine (gpu:false — loaded or lazy-loadable
  //     alongside any GPU engine, callable like a cloud provider)
  //   - every cloud provider model slug
  //
  // GPU engines other than the current one are excluded: using them
  // requires a switch (VRAM exclusion).

  app.get('/v1/models', async () => {
    const { listEngines, getEntry, venvExists } = await import('../engine/registry.js');
    const { listCloudEngines } = await import('../cloud/registry.js');

    const data = [];

    data.push({
      id: 'nspeech',
      object: 'model',
      owned_by: 'nspeech',
      description: `Current local engine (${manager.currentEngine})`,
    });

    for (const name of listEngines()) {
      const entry = getEntry(name);
      // Skip: internal workers, GPU engines (not the current one), missing venvs,
      // dashboard-only engines (api_hidden — switchable via dashboard, not a model)
      if (entry.stt) continue;
      if (entry.api_hidden) continue;
      if (entry.gpu && name !== manager.currentEngine) continue;
      if (!venvExists(name)) continue;
      data.push({
        id: name,
        object: 'model',
        owned_by: 'nspeech',
        description: entry.gpu ? 'Local GPU engine (current)' : 'Local engine (always available)',
      });
    }

    for (const c of listCloudEngines()) {
      for (const m of c.models) {
        data.push({
          id: m,
          object: 'model',
          owned_by: c.name,
          description: `Cloud provider (${c.name})`,
        });
      }
    }

    return { object: 'list', data };
  });

  // ── GET /v1/admin/engines — list available engines ───────────────────────

  app.get('/v1/admin/engines', async () => {
    const { listEngines, getEntry, venvExists } = await import('../engine/registry.js');
    const { listCloudEngines } = await import('../cloud/registry.js');

    const localEngines = listEngines().filter(name => {
      // "stt" is an internal worker (transcription/alignment), not a TTS
      // engine — excluded from switching and the TTS engine surface.
      const entry = getEntry(name);
      return !entry.stt;
    }).map(name => {
      const entry = getEntry(name);
      return {
        name,
        gpu: entry.gpu,
        venv_exists: venvExists(name),
        is_current: manager.currentEngine === name,
        is_loaded: manager.workers.has(name) && manager.workers.get(name).state === 'ready',
      };
    });

    const cloudEngines = listCloudEngines().map(c => ({
      name: c.name,
      type: 'cloud',
      models: c.models,
      health: c.health.status,
      is_current: false,
      is_loaded: c.health.status === 'ready',
    }));

    return {
      engines: [...localEngines, ...cloudEngines],
      current: manager.currentEngine,
    };
  });
}
