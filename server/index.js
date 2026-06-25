/**
 * nSpeech V3 — Node API Server.
 *
 * Serves the dashboard, static assets, and proxies requests to per-engine
 * Python workers via the EngineManager.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import { manager } from './engine/manager.js';
import { WorkerError } from './engine/worker.js';

// ── Initialize logger ───────────────────────────────────────────────────────

logger.setLogDir(resolve(config.projectRoot, config.logDir));
logger.setLevel(config.logLevel);
const log = logger.child('server');

// ── Fastify instance ────────────────────────────────────────────────────────

const app = Fastify({
  logger: false, // we use our own nLogger-compatible logger
  bodyLimit: 50 * 1024 * 1024, // 50MB for audio uploads
});

// ── Static mounts ───────────────────────────────────────────────────────────

// /web → web/ (html=true so directory requests serve index.html)
await app.register(fastifyStatic, {
  root: config.webDir,
  prefix: '/web/',
});

// /lib → lib/ (NUI submodule assets)
await app.register(fastifyStatic, {
  root: config.libDir,
  prefix: '/lib/',
  decorateReply: false, // avoid double-decorate from the first registration
});

// Multipart support for file uploads (voice cloning, STT)
await app.register(fastifyMultipart, {
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ── Initialize engine manager ───────────────────────────────────────────────

manager.init(config.defaultEngine);

// ── Helper: send a WorkerError as an OpenAI-compatible error response ───────

function sendWorkerError(reply, err) {
  const status = err.status || 503;
  const body = err.toJSON ? err.toJSON() : {
    error: { message: err.message, type: 'engine_error', code: 'unknown' },
  };
  reply.code(status).send(body);
}

/**
 * Convert a Web ReadableStream (from fetch) to a Node Readable stream
 * that Fastify can send. Returns null if the body is empty.
 */
function webStreamToNode(webStream) {
  if (!webStream) return null;
  return Readable.fromWeb(webStream);
}

// ── Dashboard routes ────────────────────────────────────────────────────────

/**
 * Root — serve the dashboard.
 */
app.get('/', async (_request, reply) => {
  const indexPath = resolve(config.webDir, 'index.html');
  try {
    const html = await readFile(indexPath);
    reply.type('text/html').send(html);
  } catch {
    reply.type('text/html').send('<h1>nSpeech V3 API</h1><p>No dashboard installed.</p>');
  }
});

/**
 * Engine info — returns the current engine name.
 */
app.get('/engine', async () => {
  return { engine: manager.currentEngine };
});

/**
 * Health check for the Node server.
 */
app.get('/health', async () => {
  return { status: 'ok', version: '3.0.0', engine: manager.currentEngine };
});

/**
 * Engine manager status — shows all workers and their states.
 */
app.get('/v1/admin/status', async () => {
  return manager.getStatus();
});

// ── Worker proxy routes ─────────────────────────────────────────────────────
//
// These routes forward requests to the appropriate engine worker.
// Node is transport-only: it does not generate, transcode, or modify audio.
// The engine is resolved from the request body or defaults to the current engine.

/**
 * POST /v1/audio/speech — proxy TTS to the engine worker.
 * Engine is resolved from body.engine or body.model, falling back to current.
 */
app.post('/v1/audio/speech', async (request, reply) => {
  const body = typeof request.body === 'object' ? request.body : {};
  const engineName = body.engine || body.model || manager.currentEngine;

  let worker;
  try {
    worker = await manager.getWorker(engineName);
  } catch (err) {
    return sendWorkerError(reply, err);
  }

  try {
    const resp = await worker.relay('POST', '/v1/audio/speech', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.raw.socket.destroyed ? AbortSignal.abort() : undefined,
    });

    // Forward the response — read body and send to client
    reply.code(resp.status);
    const contentType = resp.headers.get('content-type');
    if (contentType) reply.type(contentType);

    if (resp._stallTimer) clearTimeout(resp._stallTimer);

    if (resp.body) {
      const buf = Buffer.from(await resp.arrayBuffer());
      reply.send(buf);
    } else {
      reply.send();
    }
  } catch (err) {
    sendWorkerError(reply, err);
  }
});

/**
 * GET /v1/voices — list voices for the current engine.
 */
app.get('/v1/voices', async (request, reply) => {
  const engineName = request.query.engine || manager.currentEngine;

  let worker;
  try {
    worker = await manager.getWorker(engineName);
  } catch (err) {
    return sendWorkerError(reply, err);
  }

  try {
    const resp = await worker.relay('GET', '/v1/voices');
    reply.code(resp.status).send(await resp.json());
  } catch (err) {
    sendWorkerError(reply, err);
  }
});

/**
 * POST /v1/voices/clone — multipart upload, forwarded to worker.
 */
app.post('/v1/voices/clone', async (request, reply) => {
  const engineName = (request.query.engine || manager.currentEngine);

  let worker;
  try {
    worker = await manager.getWorker(engineName);
  } catch (err) {
    return sendWorkerError(reply, err);
  }

  try {
    // Forward the raw multipart body
    const contentType = request.headers['content-type'];
    const resp = await worker.relay('POST', '/v1/voices/clone', {
      headers: { 'content-type': contentType },
      body: request.raw,
    });

    reply.code(resp.status);
    if (resp.headers.get('content-type')) reply.type(resp.headers.get('content-type'));
    const text = await resp.text();
    reply.send(text);
  } catch (err) {
    sendWorkerError(reply, err);
  }
});

/**
 * POST /v1/voices/preview — multipart upload, forwarded to worker.
 */
app.post('/v1/voices/preview', async (request, reply) => {
  const engineName = (request.query.engine || manager.currentEngine);

  let worker;
  try {
    worker = await manager.getWorker(engineName);
  } catch (err) {
    return sendWorkerError(reply, err);
  }

  try {
    const contentType = request.headers['content-type'];
    const resp = await worker.relay('POST', '/v1/voices/preview', {
      headers: { 'content-type': contentType },
      body: request.raw,
    });

    reply.code(resp.status);
    if (resp.headers.get('content-type')) reply.type(resp.headers.get('content-type'));
    const nodeStream = webStreamToNode(resp.body);
    if (nodeStream) {
      nodeStream.on('end', () => { if (resp._stallTimer) clearTimeout(resp._stallTimer); });
      nodeStream.on('error', () => { if (resp._stallTimer) clearTimeout(resp._stallTimer); });
      reply.send(nodeStream);
    } else {
      if (resp._stallTimer) clearTimeout(resp._stallTimer);
      reply.send();
    }
  } catch (err) {
    sendWorkerError(reply, err);
  }
});

/**
 * POST /v1/voices/mix — JSON body, forwarded to worker.
 */
app.post('/v1/voices/mix', async (request, reply) => {
  const engineName = manager.currentEngine;

  let worker;
  try {
    worker = await manager.getWorker(engineName);
  } catch (err) {
    return sendWorkerError(reply, err);
  }

  try {
    const resp = await worker.relay('POST', '/v1/voices/mix', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    reply.code(resp.status).send(await resp.text());
  } catch (err) {
    sendWorkerError(reply, err);
  }
});

/**
 * DELETE /v1/voices/:voice_id — delete a voice.
 */
app.delete('/v1/voices/:voiceId', async (request, reply) => {
  const engineName = (request.query.engine || manager.currentEngine);
  const { voiceId } = request.params;

  let worker;
  try {
    worker = await manager.getWorker(engineName);
  } catch (err) {
    return sendWorkerError(reply, err);
  }

  try {
    const resp = await worker.relay('DELETE', `/v1/voices/${encodeURIComponent(voiceId)}`);
    reply.code(resp.status).send(await resp.text());
  } catch (err) {
    sendWorkerError(reply, err);
  }
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(signal) {
  log.info('shutting down', { signal });

  // Stop all engine workers first
  await manager.shutdownAll();

  try {
    await app.close();
    log.info('server closed cleanly');
  } catch (err) {
    log.error('error during shutdown', { error: err.message });
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Start ───────────────────────────────────────────────────────────────────

try {
  await app.listen({ host: config.host, port: config.port });
  const url = `http://${config.host}:${config.port}/`;
  log.info('nSpeech V3 server started', { url, engine: config.currentEngine });

  console.log('=========================================');
  console.log('      Starting nSpeech V3 API Server     ');
  console.log('=========================================');
  console.log(`• Dashboard: ${url}`);
  console.log(`• Engine:    ${config.currentEngine}`);
  console.log(`• Health:    ${url}health`);
  console.log('• Stop Server: Press Ctrl+C');
  console.log('=========================================\n');
} catch (err) {
  log.error('failed to start server', { error: err.message });
  process.exit(1);
}
