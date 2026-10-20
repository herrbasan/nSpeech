/**
 * Completed stitch renders, persisted to disk (issue #4).
 *
 * Why: a stitch render is buffered by definition — the full PCM exists before
 * the first byte reaches the client. On 2026-09-24 two ElevenLabs renders
 * (~14K chars, 4 chunks, ~4m45s each) completed server-side while the client
 * connection had already died, and the audio was piped into a dead socket and
 * discarded: ~8k credits, nothing recoverable. Stitch output lived only in
 * memory (`Buffer.concat` inside generateChunkedBatch) and never touched disk.
 *
 * What this module does:
 *   - keyed by everything that determines the audio: engine, model, voice,
 *     speed, instructions, tuning extra_body, and the CLEANED text. Two requests
 *     that would render identical audio share an entry; anything that changes
 *     the audio changes the key.
 *   - a repeated identical request within the TTL is served from disk instead of
 *     re-spending quota, so a client failure is a free retry.
 *   - `extra_body.cache: false` opts a request out of both lookup and store.
 *   - TTL plus a byte cap with least-recently-used eviction (`.cache/renders`).
 *
 * Only stitch is cached: stream mode never holds the finished render, so there
 * is nothing to persist at the moment persistence would matter.
 *
 * Disk is a boundary this module does not control. An IO failure never fails a
 * request — it is logged and the request proceeds without the cache. That
 * tolerance is deliberate and always leaves a trace.
 */
import { createHash } from 'node:crypto';
import {
  mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const log = logger.child('render-cache');

/** Bumped when the key payload or the stored format changes — old entries stop matching. */
const KEY_VERSION = 1;

/**
 * extra_body keys that do NOT affect the rendered audio.
 *  - cache: this module's own switch
 *  - clean/markdown: already applied to the text the key is computed from
 *  - mode/batch/auto_chunk: chunking transport, not the samples
 */
const NON_AUDIO_KEYS = new Set(['cache', 'clean', 'markdown', 'mode', 'batch', 'auto_chunk']);

/**
 * Stable, order-independent serialization — a client that sends the same
 * parameters in a different order must hit the same entry.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Cache key for a render.
 *
 * @param {object} opts
 * @param {string} opts.engineName — canonical engine name
 * @param {string|null} [opts.subModel] — provider model
 * @param {string} opts.voiceName — final voice, after defaults and presets
 * @param {number|undefined} [opts.speed]
 * @param {string|undefined} [opts.instructions]
 * @param {object} [opts.extraBody] — client extra_body, already merged with defaults/presets
 * @param {string} opts.text — CLEANED text, exactly what the engine will speak
 * @returns {string} — 64-char hex
 */
export function keyFor({ engineName, subModel, voiceName, speed, instructions, extraBody, text }) {
  const extra = {};
  for (const [k, v] of Object.entries(extraBody ?? {})) {
    if (!NON_AUDIO_KEYS.has(k)) extra[k] = v;
  }
  const payload = canonical({
    v: KEY_VERSION,
    engine: engineName,
    model: subModel ?? null,
    voice: voiceName,
    speed: speed ?? null,
    instructions: instructions ?? null,
    extra,
    text,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function _paths(key) {
  return {
    pcm: join(config.renderCache.dir, `${key}.pcm`),
    meta: join(config.renderCache.dir, `${key}.json`),
  };
}

/**
 * Look up a completed render.
 *
 * Touches the entry on a hit so eviction is least-recently-USED, not
 * least-recently-written — a render reused daily is not the one to drop.
 *
 * @param {string} key
 * @returns {Promise<{pcm: Buffer, meta: object}|null>}
 */
export async function lookup(key) {
  const paths = _paths(key);
  try {
    let meta;
    try {
      meta = JSON.parse(await readFile(paths.meta, 'utf8'));
    } catch {
      return null; // no sidecar → no entry
    }

    const age = Date.now() - (meta.created ?? 0);
    if (age > config.renderCache.ttlMs) {
      log.info('render cache entry expired', { key, ageHours: Math.round(age / 3600000) });
      await _remove(key);
      return null;
    }

    const pcm = await readFile(paths.pcm);
    if (pcm.length !== meta.bytes) {
      // A truncated write is a corrupt entry, not a cache miss worth guessing at.
      log.warn('render cache entry size mismatch — dropped', { key, expected: meta.bytes, actual: pcm.length });
      await _remove(key);
      return null;
    }

    const now = new Date();
    await utimes(paths.pcm, now, now);
    return { pcm, meta };

  } catch (err) {
    log.warn('render cache lookup failed', { key, error: err.message });
    return null;
  }
}

/**
 * Persist a completed render. PCM goes to a temp file and is renamed, so a
 * concurrent lookup can never read a partial file; the sidecar is written last
 * because it is what makes the entry discoverable.
 *
 * @param {string} key
 * @param {Buffer} pcm
 * @param {object} meta — { engine, model, voice, chars }
 * @returns {Promise<boolean>} — true when the entry is on disk
 */
export async function store(key, pcm, meta) {
  const paths = _paths(key);
  const tmp = `${paths.pcm}.tmp`;
  try {
    if (pcm.length > config.renderCache.maxBytes) {
      log.info('render cache skipped — render exceeds the cache byte cap', {
        key, bytes: pcm.length, cap: config.renderCache.maxBytes,
      });
      return false;
    }

    await mkdir(config.renderCache.dir, { recursive: true });
    await writeFile(tmp, pcm);
    await rename(tmp, paths.pcm);
    await writeFile(paths.meta,
      JSON.stringify({ ...meta, key, bytes: pcm.length, created: Date.now() }, null, 2));

    log.info('render persisted', { key, bytes: pcm.length, engine: meta.engine, voice: meta.voice });
    await _prune();
    return true;

  } catch (err) {
    log.warn('render persist failed', { key, error: err.message });
    try { await unlink(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

/** Evict by TTL, then least-recently-used until the directory fits the byte cap. */
async function _prune() {
  try {
    const files = await readdir(config.renderCache.dir);
    const entries = [];
    for (const f of files.filter(name => name.endsWith('.pcm'))) {
      const path = join(config.renderCache.dir, f);
      try {
        const st = await stat(path);
        entries.push({ key: f.slice(0, -4), bytes: st.size, mtime: st.mtimeMs });
      } catch {
        // vanished between readdir and stat — nothing to evict
      }
    }
    entries.sort((a, b) => a.mtime - b.mtime);

    let total = entries.reduce((sum, e) => sum + e.bytes, 0);
    for (const entry of entries) {
      const expired = Date.now() - entry.mtime > config.renderCache.ttlMs;
      if (!expired && total <= config.renderCache.maxBytes) break;
      await _remove(entry.key);
      total -= entry.bytes;
      log.info('render evicted', { key: entry.key, bytes: entry.bytes, reason: expired ? 'ttl' : 'size cap' });
    }
  } catch (err) {
    log.warn('render cache prune failed', { error: err.message });
  }
}

async function _remove(key) {
  const paths = _paths(key);
  for (const p of [paths.pcm, paths.meta]) {
    try { await unlink(p); } catch { /* already gone */ }
  }
}

/** Diagnostic view for GET /v1/admin/cache. */
export async function status() {
  const limits = {
    maxBytes: config.renderCache.maxBytes,
    ttlHours: Math.round(config.renderCache.ttlMs / 3600000),
    dir: config.renderCache.dir,
  };
  try {
    const files = (await readdir(config.renderCache.dir)).filter(f => f.endsWith('.pcm'));
    let bytes = 0;
    for (const f of files) {
      try { bytes += (await stat(join(config.renderCache.dir, f))).size; } catch { /* gone */ }
    }
    return { ...limits, entries: files.length, bytes };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...limits, entries: 0, bytes: 0 };
    return { ...limits, error: err.message };
  }
}

/**
 * Collect a fully-buffered PCM stream into one Buffer.
 *
 * Stitch already builds the complete render before returning its stream, so this
 * costs no extra latency — it hands persistence the same bytes the client is
 * about to receive, before the client can disappear.
 *
 * @param {import('node:stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
export async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
