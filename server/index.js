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
import { resolve } from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import { manager } from './engine/manager.js';
import { registerSpeechRoute } from './api/speech.js';
import { registerSpeechCloneRoute } from './api/speech-clone.js';
import { registerVoiceRoutes } from './api/voices.js';

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

// ── API routes (OpenAI-compatible surface) ──────────────────────────────────

registerSpeechRoute(app);
registerSpeechCloneRoute(app);
registerVoiceRoutes(app);

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
