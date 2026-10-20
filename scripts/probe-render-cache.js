/**
 * Probe: persisted stitch renders (issue #4).
 *
 * The failure being fixed: a stitch render completes server-side after the
 * client connection has died, and the finished audio is discarded — the quota is
 * spent with nothing to show. Persistence makes that retry free.
 *
 * Checks:
 *   A. Key — stable across parameter order, sensitive to everything that changes
 *      the audio, blind to transport flags.
 *   B. Roundtrip — store/lookup returns byte-identical audio plus metadata.
 *   C. Miss / TTL — unknown keys are misses; expired entries are dropped on read.
 *   D. Corruption — a truncated PCM file is dropped, not served.
 *   E. Capacity — the byte cap evicts least-recently-used entries, and a render
 *      larger than the cap is not stored at all.
 *   F. collect() — a multi-chunk stream reassembles losslessly.
 *
 * Uses its own directory and a small cap via env, read before config.js loads.
 * Run: node scripts/probe-render-cache.js
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const DIR = mkdtempSync(join(tmpdir(), 'nspeech-render-cache-'));
process.env.NSPEECH_RENDER_CACHE_DIR = DIR;
process.env.NSPEECH_RENDER_CACHE_TTL_DAYS = '1';
process.env.NSPEECH_RENDER_CACHE_MAX_BYTES = '3000';

const cache = await import('../server/render-cache.js');

let failures = 0;
function report(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = {
  engineName: 'elevenlabs',
  subModel: 'eleven_v3',
  voiceName: '21m00Tcm4TlvDq8ikWAM',
  speed: 1,
  instructions: 'warm narration',
  extraBody: { mode: 'stitch', clean: true, chunk_overlap: 1 },
  text: 'Ein Text, der gesprochen wird.',
};

// ── A. Key ─────────────────────────────────────────────────────────────────
const keyA = cache.keyFor(BASE);

report('identical parameters → identical key', cache.keyFor({ ...BASE }) === keyA);

report('extra_body key order does not matter',
  cache.keyFor({ ...BASE, extraBody: { chunk_overlap: 1, clean: true, mode: 'stitch' } }) === keyA);

report('transport flags (cache/clean/markdown/mode/batch/auto_chunk) are excluded',
  cache.keyFor({
    ...BASE,
    extraBody: { chunk_overlap: 1, cache: false, clean: 'llm', markdown: true, batch: true, auto_chunk: false },
  }) === keyA);

for (const [label, override] of [
  ['different text', { text: BASE.text + ' ' }],
  ['different voice', { voiceName: 'pNInz6obpgDQGcFmaJgB' }],
  ['different speed', { speed: 0.9 }],
  ['different instructions', { instructions: 'excited' }],
  ['different model', { subModel: 'eleven_v4_turbo' }],
  ['different engine', { engineName: 'minimax' }],
  ['different tuning extra_body', { extraBody: { ...BASE.extraBody, nfe_step: 32 } }],
]) {
  report(`key changes on ${label}`, cache.keyFor({ ...BASE, ...override }) !== keyA);
}

// ── B. Roundtrip ───────────────────────────────────────────────────────────
const pcm = randomBytes(1200);
const stored = await cache.store(keyA, pcm, { engine: 'elevenlabs', model: 'eleven_v3', voice: '21m00Tcm4TlvDq8ikWAM', chars: 31 });
report('store reports the entry is on disk', stored === true);

const hit = await cache.lookup(keyA);
report('lookup returns the entry', hit !== null);
report('bytes are identical', hit && hit.pcm.equals(pcm),
  hit ? `${hit.pcm.length} vs ${pcm.length}` : 'no entry');
report('metadata survives',
  hit && hit.meta.engine === 'elevenlabs' && hit.meta.bytes === pcm.length,
  hit ? JSON.stringify({ engine: hit.meta.engine, bytes: hit.meta.bytes }) : '');

// ── C. Miss / TTL ──────────────────────────────────────────────────────────
report('unknown key is a miss', (await cache.lookup('0'.repeat(64))) === null);

{
  const keyTtl = cache.keyFor({ ...BASE, text: 'expired render' });
  await cache.store(keyTtl, randomBytes(500), { engine: 'elevenlabs', voice: 'x', chars: 14 });
  const metaPath = join(DIR, `${keyTtl}.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.created = Date.now() - (2 * 24 * 3600 * 1000); // older than the 1-day TTL
  writeFileSync(metaPath, JSON.stringify(meta));
  report('expired entry is a miss', (await cache.lookup(keyTtl)) === null);
  report('expired entry is removed from disk', !existsSync(metaPath) && !existsSync(join(DIR, `${keyTtl}.pcm`)));
}

// ── D. Corruption ──────────────────────────────────────────────────────────
{
  const keyBad = cache.keyFor({ ...BASE, text: 'truncated render' });
  await cache.store(keyBad, randomBytes(800), { engine: 'elevenlabs', voice: 'x', chars: 17 });
  const pcmPath = join(DIR, `${keyBad}.pcm`);
  const truncated = readFileSync(pcmPath).subarray(0, 10);
  writeFileSync(pcmPath, truncated);
  report('truncated entry is a miss', (await cache.lookup(keyBad)) === null);
  report('truncated entry is removed', !existsSync(pcmPath) && !existsSync(join(DIR, `${keyBad}.json`)));
}

// ── E. Capacity ────────────────────────────────────────────────────────────
// Everything currently on disk is cleared so the cap is measured cleanly.
for (const f of readdirSync(DIR)) rmSync(join(DIR, f));

{
  const kOld = cache.keyFor({ ...BASE, text: 'oldest' });
  const kMid = cache.keyFor({ ...BASE, text: 'middle' });
  const kNew = cache.keyFor({ ...BASE, text: 'newest' });

  await cache.store(kOld, randomBytes(1200), { engine: 'elevenlabs', voice: 'x', chars: 6 });
  await sleep(20);
  await cache.store(kMid, randomBytes(1200), { engine: 'elevenlabs', voice: 'x', chars: 6 });
  await sleep(20);

  // Touch the oldest so eviction is least-recently-USED, not least-recently-written.
  await cache.lookup(kOld);
  await sleep(20);

  await cache.store(kNew, randomBytes(1200), { engine: 'elevenlabs', voice: 'x', chars: 6 });
  await sleep(20);

  const remaining = (await cache.status()).entries;
  report('byte cap holds (3000 bytes, three 1200-byte renders)', remaining === 2, `${remaining} entries`);
  report('least-recently-used entry was evicted', (await cache.lookup(kMid)) === null);
  report('recently used entry survived', (await cache.lookup(kOld)) !== null);
  report('newest entry survived', (await cache.lookup(kNew)) !== null);
}

{
  const kHuge = cache.keyFor({ ...BASE, text: 'oversized' });
  const storedHuge = await cache.store(kHuge, randomBytes(4000), { engine: 'elevenlabs', voice: 'x', chars: 9 });
  report('render larger than the cap is not stored', storedHuge === false && (await cache.lookup(kHuge)) === null);
}

// ── F. collect() ───────────────────────────────────────────────────────────
{
  const parts = [randomBytes(100), randomBytes(250), randomBytes(7)];
  const expected = Buffer.concat(parts);
  const got = await cache.collect(Readable.from(parts));
  report('collect() reassembles multi-chunk streams losslessly',
    got.length === expected.length && createHash('sha256').update(got).digest('hex') === createHash('sha256').update(expected).digest('hex'));
}

const status = await cache.status();
report('status reports the directory and limits',
  status.dir === DIR && status.maxBytes === 3000 && status.ttlHours === 24,
  JSON.stringify(status));

rmSync(DIR, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
