/**
 * POST /v1/speech/dialogue — one audio file from a multi-speaker MD-Blocks post.
 *
 * Per-turn synthesis + concatenation (decided 2026-10-23, not re-litigated):
 * a dialogue's prosody depends on the reply it answers, so each turn is
 * rendered in its own voice with the neighbouring turns as context, and the
 * master is a dumb concat. Per-voice slabs would need a re-split step and would
 * read as a monologue list.
 *
 * Division of labour:
 *   the document — identity only (`preset=narration:<speaker-id>`)
 *   the cast     — engine/voice/model, resolved per speaker (dialogue-cast.js)
 *   this route   — turn cache, gap/pause assembly, master transcode
 *
 * Request:
 *   { source: { markdown: "<full post>", file?: "<name for errors>" },
 *     cast?: { "<speaker-id>": { model|engine, voice_id, settings? } },
 *     gap_ms?: 400, estimate_only?: false, response_format?: "mp3" }
 *
 * Response:
 *   audio bytes, or — with `estimate_only: true` — the free turn manifest
 *   (speaker/engine char counts). Headers carry `X-Dialogue-Id`, so the written
 *   manifest can be fetched at GET /v1/speech/dialogue/:id.
 *
 * Fail modes are designed away rather than caught: an unbound speaker, a turn
 * that renders as silence, and an unparseable document all fail before any
 * bytes reach the client. Nothing ever falls back to another engine or a
 * default voice — a wrong voice on a byline is worse than a failed render.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { WorkerError } from '../engine/worker.js';
import { pipePcmToClient } from '../transcode.js';
import { getContentType, normalizeFormat, TRANSCODE_FORMATS, RAW_FORMATS } from './formats.js';
import { cleanMarkdown } from '../markdown-clean.js';
import * as chunking from '../chunking.js';
import * as renderCache from '../render-cache.js';
import { parseDialogue } from '../dialogue-parse.js';
import * as cast from '../dialogue-cast.js';
import { resolveSpeechParams } from '../speech-params.js';
import { trimEdgeSilence, silence, durationMs } from '../dialogue-audio.js';

const log = logger.child('dialogue');

/** Context windows handed to providers that support reply continuity (§5). */
const PREV_TAIL_CHARS = 500;
const NEXT_HEAD_CHARS = 250;

/**
 * Per-engine generation capabilities — a table, not per-call branches.
 *
 * `context` — the provider accepts `previous_text`/`next_text`. Only ElevenLabs
 * documents them (and its adapter drops them for the v3 family itself, which
 * rejects the fields). Every other engine reads neither, so sending them would
 * be a silent no-op dressed as a feature.
 *
 * A fixed `seed` is deliberately NOT derived per turn: ElevenLabs' seed support
 * differs by model and has not been verified for v4, and an unverified field on
 * every turn is an outage waiting for the wrong model. Reproducibility comes
 * from the turn cache instead; a caller who wants a pinned seed puts it in the
 * binding's `settings`, where it is explicit and visible.
 */
const CAPABILITIES = {
  elevenlabs: { context: true },
  minimax: { context: false },
  gemini: { context: false },
  xai: { context: false },
  fish: { context: false },
};
const NO_CAPABILITIES = { context: false };

// ═══════════════════════════════════════════════════════════════════════════
//  Route
// ═══════════════════════════════════════════════════════════════════════════

export function registerDialogueRoute(app) {
  app.post('/v1/speech/dialogue', async (request, reply) => {
    const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
    await relayDialogue(request, reply, body);
  });

  // The verification surface: the manifest written by the render above.
  app.get('/v1/speech/dialogue/:id', async (request, reply) => {
    const id = String(request.params?.id ?? '');
    if (!/^[a-f0-9]{64}$/.test(id)) {
      return reply.code(400).send({
        error: {
          message: 'manifest id must be the 64-character hex id returned in X-Dialogue-Id',
          type: 'invalid_request_error',
          code: 'invalid_manifest_id',
        },
      });
    }
    try {
      const text = await readFile(join(config.dialogue.cache.dir, `${id}.manifest.json`), 'utf8');
      return reply.type('application/json').send(text);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({
          error: {
            message: `no dialogue manifest for id ${id}`,
            type: 'invalid_request_error',
            code: 'manifest_not_found',
          },
        });
      }
      throw err;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Relay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render a dialogue document to one PCM master.
 * `deps.resolveParams` is a test seam for the offline probe (a fake engine has
 * no entry in the engine manager); production always uses the shared path.
 */
export async function relayDialogue(request, reply, body, deps = {}) {
  const resolveParams = deps.resolveParams ?? resolveSpeechParams;
  // ── Request shape ───────────────────────────────────────────────────────
  const source = body.source;
  if (!source || typeof source.markdown !== 'string' || source.markdown.trim() === '') {
    return sendError(reply, Object.assign(
      new Error("Missing required field: 'source.markdown'"),
      { status: 400, type: 'invalid_request_error', code: 'missing_source' },
    ));
  }
  const file = typeof source.file === 'string' && source.file ? source.file : '<inline>';

  const gapMs = body.gap_ms === undefined ? config.dialogue.gapMs : Number(body.gap_ms);
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    return sendError(reply, Object.assign(
      new Error(`invalid gap_ms: ${JSON.stringify(body.gap_ms)} — a non-negative number of milliseconds`),
      { status: 400, type: 'invalid_request_error', code: 'invalid_gap_ms' },
    ));
  }

  const castOverride = body.cast ?? {};
  if (typeof castOverride !== 'object' || Array.isArray(castOverride)) {
    return sendError(reply, Object.assign(
      new Error('cast must be an object of { "<speaker-id>": { ... } }'),
      { status: 400, type: 'invalid_request_error', code: 'invalid_cast' },
    ));
  }

  // ── Parse (structure, then speech text) ─────────────────────────────────
  let parsed;
  try {
    parsed = parseDialogue(source.markdown, { file });
  } catch (err) {
    return sendError(reply, err);
  }

  const items = [];
  for (const item of parsed.items) {
    if (item.type === 'beat') { items.push(item); continue; }
    const text = cleanMarkdown(item.markdown);
    if (text.trim() === '') {
      return sendError(reply, new WorkerError(400, 'dialogue_empty_turn',
        `${file}:${item.line}: narration for "${item.speaker}" is markup only — nothing to speak`));
    }
    items.push({ ...item, text });
  }

  // ── Bindings ────────────────────────────────────────────────────────────
  const bindings = new Map();
  try {
    for (const speaker of parsed.speakers) {
      bindings.set(speaker.id, cast.resolveSpeaker(speaker.id, castOverride));
    }
  } catch (err) {
    return sendError(reply, err);
  }

  const id = jobId({ markdown: source.markdown, gapMs, bindings });

  // ── Estimate (no engine call, no worker spawn, no charge) ───────────────
  if (body.estimate_only === true) {
    log.info('dialogue estimate', { id, file, turns: parsed.speakers.reduce((n, s) => n + s.turns, 0) });
    return reply.send(buildEstimate({ id, file, items, bindings, gapMs }));
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const clientFormat = normalizeFormat(body.response_format);

  // A dead client must stop the spend. The response socket is the reliable
  // signal (an IncomingMessage 'close' can fire before streaming even starts —
  // see the speech relay); turns already rendered are on disk either way, so a
  // disconnect costs nothing that a retry does not reuse.
  const abort = new AbortController();
  let responseDone = false;
  reply.raw.on('finish', () => { responseDone = true; });
  reply.raw.on('close', () => { if (!responseDone) abort.abort(); });

  const parts = [];
  const manifestTurns = [];
  const totalTurns = items.filter((i) => i.type === 'turn').length;
  let pendingBeatsMs = 0;
  let emittedTurn = false;
  let cacheHits = 0;
  const contextEngines = new Set();

  try {
    for (const item of items) {
      if (abort.signal.aborted) {
        log.info('dialogue aborted by client', { id, completedTurns: manifestTurns.length });
        return;
      }

      if (item.type === 'beat') {
        pendingBeatsMs += item.seconds * 1000;
        continue;
      }

      const binding = bindings.get(item.speaker);
      const caps = CAPABILITIES[binding.engine] ?? NO_CAPABILITIES;

      // `settings` are extra_body keys; `speed` is nSpeech's own top-level field.
      const extraBody = { ...binding.settings };
      const speed = extraBody.speed;
      delete extraBody.speed;
      if (caps.context) {
        contextEngines.add(binding.engine);
        const prev = turnText(items, item.index - 1);
        const next = turnText(items, item.index + 1);
        if (prev) extraBody.previous_text = tail(prev, PREV_TAIL_CHARS);
        if (next) extraBody.next_text = head(next, NEXT_HEAD_CHARS);
      }

      // Same resolution path as /v1/audio/speech: defaults fill unset fields,
      // presets resolve, and the final voice is validated before any spend.
      const params = await resolveParams({
        model: binding.model,
        voice: binding.voice_id,
        speed,
        extra_body: extraBody,
      });

      // The key is computed from what the ENGINE will actually speak — the
      // final voice, model and extra_body — so a cast override or an edited
      // neighbouring turn invalidates exactly the turns it changes.
      const key = renderCache.keyFor({
        engineName: params.engineName,
        subModel: params.subModel,
        voiceName: params.voiceName,
        speed: params.speed,
        instructions: params.instructions,
        extraBody: params.extraBody,
        text: item.text,
      });

      let pcm;
      let cacheState = 'miss';
      const hit = await renderCache.lookup(key, config.dialogue.cache);
      if (hit) {
        pcm = hit.pcm;
        cacheState = 'hit';
        cacheHits += 1;
      } else {
        if (chunking.shouldChunk(item.text, params.engine, params.subModel)) {
          const stream = await chunking.generateChunkedBatch({
            text: item.text,
            engine: params.engine,
            voiceName: params.voiceName,
            speed: params.speed,
            instructions: params.instructions,
            extraBody: params.extraBody,
            subModel: params.subModel,
            signal: abort.signal,
          });
          pcm = await renderCache.collect(stream);
        } else {
          const stream = await params.engine.generatePcmStream({
            text: item.text,
            voice_name: params.voiceName,
            speed: params.speed,
            instruct_text: params.instructions,
            extra_body: params.extraBody,
            model: params.subModel,
            signal: abort.signal,
          });
          pcm = await renderCache.collect(stream);
        }

        if (pcm.length === 0) {
          throw new WorkerError(502, 'empty_audio',
            `turn ${item.index} (speaker "${item.speaker}") rendered no audio`);
        }
        const trimmed = trimEdgeSilence(pcm);
        if (!trimmed) {
          throw new WorkerError(502, 'empty_audio',
            `turn ${item.index} (speaker "${item.speaker}") rendered as silence`);
        }
        pcm = trimmed.pcm;

        await renderCache.store(key, pcm, {
          kind: 'dialogue-turn',
          engine: params.engineName,
          model: params.subModel ?? null,
          voice: params.voiceName,
          chars: item.text.length,
        }, config.dialogue.cache);
      }

      // Gap: a beat between two turns REPLACES the default gap (it is an
      // authored pause, not an addition to one). Before the first turn a beat
      // is leading silence; after the last, trailing.
      const gap = emittedTurn ? (pendingBeatsMs > 0 ? pendingBeatsMs : gapMs) : pendingBeatsMs;
      if (gap > 0) parts.push(silence(gap));
      pendingBeatsMs = 0;
      parts.push(pcm);
      emittedTurn = true;

      manifestTurns.push({
        index: item.index,
        speaker: item.speaker,
        name: item.name,
        line: item.line,
        engine: params.engineName,
        model: params.subModel ?? binding.model,
        voice: params.voiceName,
        binding: binding.source,
        chars: item.text.length,
        duration_ms: Math.round(durationMs(pcm)),
        cache: cacheState,
      });

      log.info('dialogue turn rendered', {
        id,
        turn: item.index,
        of: totalTurns,
        speaker: item.speaker,
        engine: params.engineName,
        chars: item.text.length,
        cache: cacheState,
        key,
      });
    }
  } catch (err) {
    // A failure mid-job leaves the completed turns cached and a manifest
    // naming them — the rerun resumes from disk instead of re-billing.
    await persistManifest(id, {
      id, file, status: 'failed', created: Date.now(), gap_ms: gapMs,
      turns: manifestTurns,
      error: { message: err.message, code: err.code ?? null },
    });
    reply.header('X-Dialogue-Id', id);
    return sendError(reply, err);
  }

  if (abort.signal.aborted) return;
  if (pendingBeatsMs > 0) parts.push(silence(pendingBeatsMs));

  const master = Buffer.concat(parts);
  const manifest = {
    id,
    file,
    status: 'ok',
    created: Date.now(),
    gap_ms: gapMs,
    turns: manifestTurns,
    totals: {
      turns: manifestTurns.length,
      chars: manifestTurns.reduce((n, t) => n + t.chars, 0),
      cache_hits: cacheHits,
      audio_ms: Math.round(durationMs(master)),
      bytes: master.length,
    },
  };
  await persistManifest(id, manifest);

  const headers = {
    'X-Dialogue-Id': id,
    'X-Dialogue-Turns': String(manifestTurns.length),
    'X-Dialogue-Cache': `${cacheHits}/${manifestTurns.length} hit`,
  };

  if (contextEngines.size === 0) {
    const engines = [...new Set([...bindings.values()].map((b) => b.engine))].join(', ');
    log.warn('no reply context for this cast — previous_text/next_text unsupported', { engines });
  }

  // ── Transport (same two paths as /v1/audio/speech) ──────────────────────
  reply.code(200).type(getContentType(clientFormat));
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);

  if (RAW_FORMATS.has(clientFormat) || !TRANSCODE_FORMATS.has(clientFormat)) {
    // Raw passthrough. The master's loudness normalization is the transcode
    // path's job (dynaudnorm); raw formats deliberately stay untouched, exactly
    // like the speech relay.
    return reply.send(master);
  }

  reply.hijack();
  pipePcmToClient(Readable.from([master]), reply.raw, clientFormat, {
    streamMode: 'dialogue',
    // reply.header() is discarded by the hijack — pipePcmToClient writes its
    // own head, so the headers have to travel explicitly (issue 3aaec81).
    extraHeaders: headers,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Pieces
// ═══════════════════════════════════════════════════════════════════════════

/** Cleaned text of the turn with the given 1-based index, or null. */
function turnText(items, index) {
  if (index < 1) return null;
  const turn = items.find((i) => i.type === 'turn' && i.index === index);
  return turn?.text ?? null;
}

const tail = (s, n) => (s.length <= n ? s : s.slice(-n));
const head = (s, n) => (s.length <= n ? s : s.slice(0, n));

/** Deterministic job id: the document, the gap, and the resolved cast. */
function jobId({ markdown, gapMs, bindings }) {
  const payload = {
    v: 1,
    gap_ms: gapMs,
    markdown,
    bindings: [...bindings]
      .map(([speaker, b]) => ({ speaker, model: b.model, voice_id: b.voice_id, settings: b.settings }))
      .sort((a, b) => (a.speaker < b.speaker ? -1 : 1)),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * The free manifest: what would be billed, per speaker and per engine.
 * Character counts are the billable unit; nSpeech models no provider pricing,
 * so no cost figure is invented here.
 */
function buildEstimate({ id, file, items, bindings, gapMs }) {
  const speakers = new Map();
  const engines = new Map();
  let turns = 0;
  let pauses = 0;
  let pauseSeconds = 0;

  for (const item of items) {
    if (item.type === 'beat') { pauses += 1; pauseSeconds += item.seconds; continue; }
    const binding = bindings.get(item.speaker);
    const s = speakers.get(item.speaker) ?? {
      id: item.speaker,
      name: item.name,
      engine: binding.engine,
      model: binding.model,
      voice_id: binding.voice_id,
      binding: binding.source,
      turns: 0,
      chars: 0,
    };
    s.turns += 1;
    s.chars += item.text.length;
    speakers.set(item.speaker, s);

    const e = engines.get(binding.engine) ?? { engine: binding.engine, turns: 0, chars: 0, models: {} };
    e.turns += 1;
    e.chars += item.text.length;
    e.models[binding.model] = (e.models[binding.model] ?? 0) + item.text.length;
    engines.set(binding.engine, e);

    turns += 1;
  }

  return {
    id,
    file,
    turns,
    speakers: [...speakers.values()],
    engines: [...engines.values()],
    gap_ms: gapMs,
    pauses: { count: pauses, seconds: pauseSeconds },
    note: 'estimated cost = chars × the provider\'s current per-character rate; nSpeech models no pricing',
  };
}

async function persistManifest(id, manifest) {
  try {
    await mkdir(config.dialogue.cache.dir, { recursive: true });
    await writeFile(join(config.dialogue.cache.dir, `${id}.manifest.json`),
      JSON.stringify(manifest, null, 2));
  } catch (err) {
    // Disk is a boundary we do not control; losing the sidecar must not lose
    // audio the caller already paid for. Always leaves a trace.
    log.warn('dialogue manifest not written', { id, error: err.message });
  }
}

function sendError(reply, err) {
  log.error('dialogue request failed', {
    message: err.message,
    status: err.status || 503,
    type: err.type || 'engine_error',
    code: err.code ?? null,
    line: err.line ?? null,
    stack: err.stack?.split('\n').slice(0, 4).join(' | '),
  });
  if (err.toJSON) return reply.code(err.status || 503).send(err.toJSON());
  return reply.code(err.status || 503).send({
    error: {
      message: err.message,
      type: err.type || 'engine_error',
      code: err.code || 'unknown',
    },
  });
}
