/**
 * nSpeech V3 — Node API Server.
 *
 * Serves the dashboard, static assets, and proxies requests to per-engine
 * Python workers via the EngineManager.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import { manager } from './engine/manager.js';
import { registerSpeechRoute } from './api/speech.js';
import { registerSpeechCloneRoute } from './api/speech-clone.js';
import { registerVoiceRoutes } from './api/voices.js';
import { registerSttRoutes } from './api/transcriptions.js';
import { registerTextRoutes } from './api/text.js';
import { registerDefaultsRoutes } from './api/defaults.js';
import { registerAdminRoutes } from './api/admin.js';
import * as voiceCache from './voice-cache.js';

// ── Initialize logger ───────────────────────────────────────────────────────

logger.setLogDir(resolve(config.projectRoot, config.logDir));
logger.setLevel(config.logLevel);
const log = logger.child('server');

// ── Fastify instance ────────────────────────────────────────────────────────

const app = Fastify({
  logger: false, // we use our own nLogger-compatible logger
  bodyLimit: 50 * 1024 * 1024, // 50MB for audio uploads
});

// ── CORS ────────────────────────────────────────────────────────────────────
// nSpeech is a local trusted service on a private LAN. Browser clients (the
// LLM Gateway Chat app on :8080, the dashboard, etc.) need cross-origin
// access for /v1/* endpoints. Plain hook — no @fastify/cors dependency.
//
// IMPORTANT: We set headers on BOTH reply.header() (normal Fastify paths)
// AND reply.raw.setHeader() (survives reply.hijack() used by the speech
// route's ffmpeg streaming). Without the raw fallback, hijacked responses
// lose CORS headers and the browser blocks them.
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  for (const [k, v] of Object.entries(headers)) {
    reply.header(k, v);
    // raw fallback for hijacked routes (speech streaming)
    if (reply.raw && !reply.raw.headersSent) reply.raw.setHeader(k, v);
  }
  // Short-circuit preflight
  if (req.method === 'OPTIONS') {
    reply.code(204).send();
  }
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

// /docs → docs/ (working documents: plans, provider research)
await app.register(fastifyStatic, {
  root: resolve(config.projectRoot, 'docs'),
  prefix: '/docs/',
  decorateReply: false,
  serveDotFiles: false,
});

// /documentation → documentation/ (project documentation: API reference)
await app.register(fastifyStatic, {
  root: resolve(config.projectRoot, 'documentation'),
  prefix: '/documentation/',
  decorateReply: false,
});

// NOTE: We intentionally do NOT register @fastify/multipart globally.
// That plugin drains request.raw during its own multipart parsing pass,
// which would leave the route handler with an empty body when forwarding
// to the engine worker. Instead, install a parser for multipart that just
// captures the raw bytes unchanged. parseAs:'buffer' makes Fastify hand us
// a Buffer (the same bytes that arrived on the socket), which we expose
// on request.body so route handlers can forward it to the worker via fetch().
// The downstream worker does the actual multipart parsing (FastAPI UploadFile/
// File/Form bindings).
app.addContentTypeParser(
  /^multipart\/form-data/,
  { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 },
  (_req, payload, done) => {
    // For parseAs:'buffer', Fastify has already collected all bytes into
    // `payload` (a Buffer). Just hand it through.
    done(null, payload);
  }
);

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

/**
 * Return random message snippets from archived LLM arena conversations.
 */
app.get('/arena-samples', async (request, reply) => {
  const { readdir, readFile } = await import('node:fs/promises');
  try {
    const archiveDir = resolve(config.projectRoot, 'docs', '_Archive');
    const files = (await readdir(archiveDir)).filter(f => f.startsWith('arena-') && f.endsWith('.json'));
    if (!files.length) {
      return { error: 'No arena archives found' };
    }
    const randomFile = files[Math.floor(Math.random() * files.length)];
    const raw = await readFile(resolve(archiveDir, randomFile), 'utf8');
    const data = JSON.parse(raw);
    const messages = (data.messages || []).filter(msg => msg.role === 'assistant' && msg.content);
    if (!messages.length) {
      return { error: 'No assistant messages found in archives' };
    }
    const chosen = messages[Math.floor(Math.random() * messages.length)];
    let content = (chosen.content || '').trim();
    if (content.length > 300) {
      const truncated = content.slice(0, 300);
      const lastPeriod = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('? '), truncated.lastIndexOf('! '));
      if (lastPeriod > 50) {
        content = truncated.slice(0, lastPeriod + 1);
      } else {
        content = truncated + '...';
      }
    }
    return {
      text: content,
      speaker: chosen.speaker || 'unknown',
      topic: data.summary?.title || '',
    };
  } catch (err) {
    return { error: err.message };
  }
});

// ── API routes (OpenAI-compatible surface) ──────────────────────────────────

registerSpeechRoute(app);
registerSpeechCloneRoute(app);
registerVoiceRoutes(app);
registerSttRoutes(app);
registerTextRoutes(app);
registerDefaultsRoutes(app);
registerAdminRoutes(app);

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
  log.info('nSpeech V3 server started', { url, engine: manager.currentEngine });

  console.log('=========================================');
  console.log('      Starting nSpeech V3 API Server     ');
  console.log('=========================================');
  console.log(`• Dashboard: ${url}`);
  console.log(`• Engine:    ${manager.currentEngine}`);
  console.log(`• Health:    ${url}health`);
  console.log('• Stop Server: Press Ctrl+C');
  console.log('=========================================\n');

  // Warm the voice cache so client voice listings are served from memory
  // instead of waiting on a worker spawn or a cloud round-trip. Deliberately
  // not awaited: the server accepts requests immediately, and warm() returns
  // as soon as the local disk scans finish (cloud + resident warm-ups run on
  // in the background).
  voiceCache.warm().catch(err => log.warn('voice cache warm-up failed', { error: err.message }));
} catch (err) {
  log.error('failed to start server', { error: err.message });
  console.error('\n=========================================');
  console.error('  FAILED TO START nSpeech V3 Server');
  console.error('=========================================');
  console.error(`Error: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other process or change NSPEECH_PORT.`);
  }
  console.error('=========================================\n');
  process.exit(1);
}
