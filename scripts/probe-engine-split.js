/**
 * Probe: the client-default / dashboard-selection split, offline.
 *
 *   node scripts/probe-engine-split.js
 *
 * Two questions that used to share one field (`currentEngine`):
 *   - which engine is the DASHBOARD working with (and, if local, resident)
 *   - which engine CLIENTS get for `model: "nspeech"` / no model
 *
 * Selecting a cloud engine used to unload the resident local engine AND take
 * the client default over. Both are asserted here, plus the routes.
 *
 * No worker is spawned and no state file is written: persistence is stubbed,
 * and the engine the resolution tests point at is a cloud adapter.
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { manager, engineNameFor } from '../server/engine/manager.js';
import { registerAdminRoutes } from '../server/api/admin.js';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(join(ROOT, 'server', 'package.json'));
const Fastify = require('fastify');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

function ok(value, what) {
  if (!value) throw new Error(what);
}

// ── Test seam: never touch the real .engine_state.json ─────────────────────
let persisted = null;
manager._persistState = () => { persisted = { engine: manager.currentEngine, defaultEngine: manager.defaultEngine }; };

manager.currentEngine = 'f5tts';
manager.defaultEngine = 'f5tts';

// ── 1. Resolution follows the CLIENT DEFAULT ───────────────────────────────
check('engineNameFor: nspeech and empty resolve to the client default', () => {
  eq(engineNameFor('nspeech'), 'f5tts', 'nspeech');
  eq(engineNameFor(null), 'f5tts', 'null');
  eq(engineNameFor(''), 'f5tts', 'empty');
  eq(engineNameFor('minimax_speech_2_8_turbo'), 'minimax', 'explicit slug still resolves to its engine');
});

await checkAsync('getEngine("nspeech") follows the default, not the dashboard', async () => {
  manager.defaultEngine = 'minimax';
  manager.currentEngine = 'f5tts';
  const resolved = await manager.getEngine('nspeech');
  eq(resolved.engine.constructor.name, 'MiniMaxAdapter', 'resolved adapter');
  eq(resolved.model, 'speech-2.8-turbo', 'provider model');

  manager.defaultEngine = 'fish';
  const fish = await manager.getEngine(null);
  eq(fish.engine.constructor.name, 'FishAdapter', 'null model follows the default too');

  manager.defaultEngine = 'f5tts';
});

// ── 2. The two pointers move independently ─────────────────────────────────
check('setCurrentEngine does not move the client default', () => {
  manager.defaultEngine = 'f5tts';
  manager.setCurrentEngine('minimax');
  eq(manager.currentEngine, 'minimax', 'dashboard context');
  eq(manager.defaultEngine, 'f5tts', 'client default unchanged');
  eq(persisted, { engine: 'minimax', defaultEngine: 'f5tts' }, 'both pointers persisted');
  manager.setCurrentEngine('f5tts');
});

check('setDefaultEngine validates and reports the previous value', () => {
  const result = manager.setDefaultEngine('elevenlabs');
  eq(result, { engine: 'elevenlabs', previous: 'f5tts' }, 'result');
  eq(manager.defaultEngine, 'elevenlabs', 'default moved');
  eq(manager.currentEngine, 'f5tts', 'dashboard context untouched');

  let err = null;
  try { manager.setDefaultEngine('not_an_engine'); } catch (e) { err = e; }
  ok(err, 'unknown engine must throw');
  eq(err.status, 404, 'status');
  eq(err.code, 'engine_not_found', 'code');
  ok(/kokoro|f5tts/.test(err.message), `message must list what is available: ${err.message}`);
  eq(manager.defaultEngine, 'elevenlabs', 'failed set leaves the default alone');

  manager.setDefaultEngine('f5tts');
});

// ── 3. Selecting a cloud engine is a context change, not a residency one ───
await checkAsync('selecting a cloud engine never unloads the resident local engine', async () => {
  const calls = [];
  const fakeWorker = {
    inFlight: 0,
    state: 'ready',
    getStatus() { return { state: 'ready' }; },
    async stop() { calls.push('stop'); },
  };
  manager.workers.set('f5tts', fakeWorker);
  manager.currentEngine = 'f5tts';
  manager.defaultEngine = 'f5tts';

  const result = await manager.switchEngine('minimax');

  eq(result, { engine: 'minimax', status: 'cloud_selected' }, 'switch result');
  eq(calls.length, 0, 'resident worker was NOT stopped');
  ok(manager.workers.has('f5tts'), 'worker still registered');
  eq(manager.currentEngine, 'minimax', 'dashboard context moved');
  eq(manager.defaultEngine, 'f5tts', 'client default stayed');

  manager.workers.delete('f5tts');
  manager.currentEngine = 'f5tts';
});

// ── 4. Routes ──────────────────────────────────────────────────────────────
const app = Fastify();
registerAdminRoutes(app);

const waitFor = async (fn, ms = 1000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
};

await checkAsync('POST /v1/admin/default-engine moves the pointer and converges residency', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/admin/default-engine', payload: { engine: 'fish' },
  });
  eq(res.statusCode, 202, 'status');
  const body = JSON.parse(res.body);
  eq(body.engine, 'fish', 'engine');
  eq(body.previous, 'f5tts', 'previous');
  eq(body.converging, true, 'converging flag');
  eq(manager.defaultEngine, 'fish', 'in-memory default moved immediately');

  // Cloud default: nothing to load, the GPU engine is freed.
  eq(await waitFor(() => manager.currentEngine === 'fish'), true, 'dashboard context followed');
});

await checkAsync('promoting a cloud default unloads the resident GPU engine', async () => {
  const calls = [];
  const fakeWorker = {
    inFlight: 0,
    state: 'ready',
    entry: { gpu: true },
    getStatus() { return { state: 'ready' }; },
    async stop() { calls.push('stop'); },
  };
  manager.workers.set('f5tts', fakeWorker);
  manager.currentEngine = 'f5tts';
  manager.defaultEngine = 'f5tts';

  manager.promoteDefaultEngine('elevenlabs');
  eq(await waitFor(() => calls.length === 1 && !manager.workers.has('f5tts')), true,
    'GPU worker stopped and dropped');
  eq(manager.defaultEngine, 'elevenlabs', 'default moved');
});

await checkAsync('promoting a local default delegates to the real switch', async () => {
  const seen = [];
  const original = manager.switchEngine;
  const originalDo = manager._doSwitch;
  manager._doSwitch = async (name) => { seen.push(name); return { engine: name, status: 'switched' }; };
  try {
    manager.promoteDefaultEngine('kokoro');
    await waitFor(() => seen.length === 1);
    eq(seen, ['kokoro'], '_doSwitch called with the promoted engine');
    eq(manager.defaultEngine, 'kokoro', 'default moved');
  } finally {
    manager._doSwitch = originalDo;
    manager.switchEngine = original;
  }
  manager.defaultEngine = 'f5tts';
});

await checkAsync('a promotion waits for an in-flight GPU start before stopping it', async () => {
  // The 2026-10-24 live failure: a cloud promotion deleted a spawning F5
  // worker, the switch behind it then spun to its 180s health timeout.
  const events = [];
  const fakeWorker = {
    inFlight: 0,
    state: 'spawning',
    entry: { gpu: true },
    getStatus() { return { state: 'spawning' }; },
    whenReady() {
      return new Promise((resolve) => setTimeout(() => { events.push('ready'); this.state = 'ready'; resolve(); }, 30));
    },
    async stop() { events.push('stop'); },
  };
  manager.workers.set('f5tts', fakeWorker);
  manager.currentEngine = 'f5tts';
  manager.defaultEngine = 'f5tts';

  manager.promoteDefaultEngine('minimax');
  eq(await waitFor(() => events.includes('stop'), 2000), true, 'worker eventually stopped');
  eq(events[0], 'ready', `start was awaited before the stop (order: ${events.join(',')})`);
  eq(manager.workers.has('f5tts'), false, 'worker dropped after the stop');
  eq(manager.defaultEngine, 'minimax', 'default moved');
});

await checkAsync('POST /v1/admin/default-engine rejects unknown and missing engines', async () => {
  const unknown = await app.inject({
    method: 'POST', url: '/v1/admin/default-engine', payload: { engine: 'bogus' },
  });
  eq(unknown.statusCode, 404, 'unknown engine status');
  eq(JSON.parse(unknown.body).error.code, 'engine_not_found', 'unknown engine code');

  const missing = await app.inject({ method: 'POST', url: '/v1/admin/default-engine', payload: {} });
  eq(missing.statusCode, 400, 'missing engine status');
  eq(JSON.parse(missing.body).error.code, 'missing_engine', 'missing engine code');
});

await checkAsync('GET /v1/admin/default-engine reports both pointers', async () => {
  manager.defaultEngine = 'f5tts';
  manager.currentEngine = 'minimax';
  const res = await app.inject({ method: 'GET', url: '/v1/admin/default-engine' });
  eq(JSON.parse(res.body), { engine: 'f5tts', dashboard: 'minimax' }, 'body');
  manager.currentEngine = 'f5tts';
});

await checkAsync('/v1/models advertises the CLIENT DEFAULT, not the browsed engine', async () => {
  manager.defaultEngine = 'f5tts';
  manager.currentEngine = 'minimax';
  const res = await app.inject({ method: 'GET', url: '/v1/models' });
  const models = JSON.parse(res.body).data;
  const nspeech = models.find((m) => m.id === 'nspeech');
  ok(nspeech, 'nspeech entry present');
  ok(/f5tts/.test(nspeech.description), `description names the default: ${nspeech.description}`);
  const f5 = models.find((m) => m.id === 'f5tts');
  ok(f5, 'the default GPU engine is advertised (no switch needed)');
  eq(f5.default, true, 'flagged as default');
  const others = models.filter((m) => ['kokoro', 'chatterbox-turbo', 'vibevoice'].includes(m.id));
  for (const m of others) {
    if (m.id !== 'f5tts' && m.engine !== 'f5tts') {
      // non-default GPU engines must not be advertised; resident CPU ones may be
      const stillListed = models.some((x) => x.id === m.id && x.description.includes('always available'));
      ok(stillListed || m.id !== 'chatterbox-turbo', `${m.id} handling`);
    }
  }
  manager.currentEngine = 'f5tts';
});

await checkAsync('/v1/admin/engines flags both current and default', async () => {
  manager.defaultEngine = 'f5tts';
  manager.currentEngine = 'minimax';
  const res = await app.inject({ method: 'GET', url: '/v1/admin/engines' });
  const body = JSON.parse(res.body);
  eq(body.current, 'minimax', 'current');
  eq(body.default, 'f5tts', 'default');
  const f5 = body.engines.find((e) => e.name === 'f5tts');
  const mm = body.engines.find((e) => e.name === 'minimax');
  eq(f5.is_default, true, 'f5tts is_default');
  eq(f5.is_current, false, 'f5tts is_current');
  eq(mm.is_current, true, 'minimax is_current');
  eq(mm.is_default, false, 'minimax is_default');
  manager.currentEngine = 'f5tts';
});

await app.close();

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
