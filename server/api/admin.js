/**
 * Engine switch endpoint with SSE progress events.
 *
 * POST /v1/admin/engine
 *
 * Request body: {"engine": "f5tts"}
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
import { config } from '../config.js';
import { getEntry } from '../engine/registry.js';
import { resolveCloud } from '../cloud/registry.js';
import { subscribe, getHistory } from '../events.js';
import { logger } from '../logger.js';
import * as voiceCache from '../voice-cache.js';
import * as renderCache from '../render-cache.js';

const log = logger.child('admin');

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

      // No busy check: selecting a cloud engine touches no worker, so an
      // in-flight local request is not a reason to refuse it (it was, back
      // when this path unloaded the engine).

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

      // ── Cloud selection is a CONTEXT change, not a residency change ──────
      // A cloud provider has no worker. Until 2026-10-24 this block unloaded
      // the resident local engine "so we don't waste VRAM" — but a cloud
      // engine uses no VRAM, so the only effects were a cold F5 for the next
      // client request and a dashboard selection that silently became the
      // client default. Neither is a switch.
      sendEvent('status', { stage: 'switch_done', engine: engineName });
      manager.setCurrentEngine(engineName);
      sendEvent('result', { engine: engineName, status: 'cloud_selected' });
      reply.raw.end();
      // Refresh this engine's cached voices in the background — the adapter
      // round-trip must not hold the switch SSE open.
      voiceCache.refresh(engineName).catch(err => log.warn('post-switch voice refresh failed', { engine: engineName, error: err.message }));
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
      // The engine is now loaded, so its answer is authoritative (native
      // catalog + disk). Fire-and-forget — the switch SSE must not wait on it.
      voiceCache.refresh(engineName).catch(err => log.warn('post-switch voice refresh failed', { engine: engineName, error: err.message }));
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
      engine: 'nspeech',
      default: true,
      description: `Client default engine (${manager.defaultEngine})`,
    });

    for (const name of listEngines()) {
      const entry = getEntry(name);
      // Skip: internal workers, GPU engines (not the client default), missing venvs,
      // dashboard-only engines (api_hidden — switchable via dashboard, not a model)
      if (entry.stt) continue;
      if (entry.api_hidden) continue;
      if (entry.gpu && name !== manager.defaultEngine) continue;
      if (!venvExists(name)) continue;
      data.push({
        id: name,
        object: 'model',
        owned_by: 'nspeech',
        engine: name,
        default: name === manager.defaultEngine,
        description: entry.gpu ? 'Local GPU engine (client default)' : 'Local engine (always available)',
      });
    }

    for (const c of listCloudEngines()) {
      for (const m of c.models) {
        data.push({
          id: m.id,
          object: 'model',
          owned_by: c.name,
          engine: c.name,
          provider_model: m.provider,
          label: m.label,
          default: m.default,
          description: `Cloud provider (${c.name}) — ${m.label}`,
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
        is_default: manager.defaultEngine === name,
        is_loaded: manager.workers.has(name) && manager.workers.get(name).state === 'ready',
      };
    });

    const cloudEngines = listCloudEngines().map(c => ({
      name: c.name,
      type: 'cloud',
      models: c.models,
      defaultModel: c.defaultModel,
      health: c.health.status,
      is_current: manager.currentEngine === c.name,
      is_default: manager.defaultEngine === c.name,
      is_loaded: c.health.status === 'ready',
    }));

    return {
      engines: [...localEngines, ...cloudEngines],
      current: manager.currentEngine,
      default: manager.defaultEngine,
    };
  });

  // ── POST /v1/admin/default-engine — the engine CLIENTS get ───────────────
  //
  // Separate from the switch on purpose: switching is what the dashboard is
  // working with (and, for a local engine, what is resident), while this is
  // what `model: "nspeech"` resolves to. Nothing in the request path changes
  // it, so a cloud test can no longer take the default over.
  //
  // Setting it is an explicit act, so it also converges residency: a local
  // engine is loaded (unloading the previous GPU engine), a cloud default
  // frees the GPU engine that is no longer needed. The pointer moves
  // immediately; the load runs in the background so a checkbox does not hang
  // on a ~30s cold start (progress arrives on /v1/admin/events).

  app.post('/v1/admin/default-engine', async (request, reply) => {
    const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
    if (!body.engine) {
      return reply.code(400).send({
        error: { message: "Missing required field: 'engine'", type: 'invalid_request_error', code: 'missing_engine', param: 'engine' },
      });
    }
    try {
      const result = manager.promoteDefaultEngine(body.engine);
      return reply.code(202).send({ ...result, status: 'default_set' });
    } catch (err) {
      return reply.code(err.status || 400).send({
        error: { message: err.message, type: 'invalid_request_error', code: err.code || 'unknown' },
      });
    }
  });

  // Same value on the read path, for the dashboard header and diagnostics.
  app.get('/v1/admin/default-engine', async () => ({
    engine: manager.defaultEngine,
    dashboard: manager.currentEngine,
  }));

  // ── GET /v1/admin/cache — voice-cache and render-cache state ─────────────
  //
  // Engines and models are deliberately absent: both are built from the local
  // registry and the cloud registry with no network and no worker, so there is
  // nothing to cache. Only voices needed a snapshot, and only stitch renders
  // need persistence.

  app.get('/v1/admin/cache', async () => ({
    ...(await voiceCache.status()),
    renders: await renderCache.status(),
    dialogue_turns: await renderCache.status(config.dialogue.cache),
  }));

  // ── POST /v1/admin/cache/refresh — rebuild the cache now ─────────────────
  //
  // Re-reads every engine's voice directory, re-fetches every cloud catalog,
  // and re-warms the resident CPU engines. Returns once the local engines are
  // rebuilt; cloud and resident warm-ups continue in the background.

  app.post('/v1/admin/cache/refresh', async () => {
    await voiceCache.warm();
    return voiceCache.status();
  });
}
