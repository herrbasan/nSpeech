/**
 * Request → generation parameters. Shared by POST /v1/audio/speech and
 * POST /v1/speech/dialogue so the two paths cannot drift.
 *
 * The order is load-bearing, each step fixed by a past bug:
 *   1. engine resolution (model string → adapter/worker + provider sub-model)
 *   2. server defaults fill ONLY fields the request left unset — an explicit
 *      value always wins, and `voice: "default"` counts as unset (2026-09-10)
 *   3. preset resolution on the resulting voice (Node-managed voice config)
 *   4. voice validation on the FINAL voice, before any engine work — a bad
 *      voice is a typed 404, not a provider round-trip (2026-09-30)
 *
 * Store lookups are keyed by the CANONICAL engine name (`engineNameFor`), never
 * by the raw model string: "nspeech" and cloud slugs never equal a stored key,
 * which made saved dial-ins look like they did not persist.
 */
import { manager, engineNameFor } from './engine/manager.js';
import * as presets from './presets.js';
import * as defaults from './defaults.js';
import { assertVoiceValid } from './voice-validation.js';
import { logger } from './logger.js';

const log = logger.child('speech-params');

/**
 * @param {{model?: string, voice?: string, speed?: number|string, instructions?: string, extra_body?: object}} body
 * @returns {Promise<{
 *   engine: object, subModel: string|null, engineName: string|null,
 *   voiceName: string, speed: number|undefined, instructions: string|undefined,
 *   extraBody: object,
 * }>}
 */
export async function resolveSpeechParams(body) {
  const extraBody = body.extra_body ?? {};

  // ── Engine ──────────────────────────────────────────────────────────────
  const resolved = await manager.getEngine(body.model);
  const engine = resolved.engine;
  const subModel = extraBody.model ?? resolved.model;

  // ── Server-side defaults (dashboard dial-ins) ───────────────────────────
  // Same normalisation as the preset lookup: keyed by canonical engine name.
  const engineName = engineNameFor(body.model);
  const def = engineName ? defaults.get(engineName) : null;
  let voice = body.voice;
  let speedInput = body.speed;
  let instructions = body.instructions;
  if (def) {
    if ((voice == null || voice === 'default') && def.voice != null && def.voice !== 'default') {
      voice = def.voice;
    }
    if (speedInput == null && def.speed != null) speedInput = def.speed;
    if (def.extra_body) {
      for (const [k, v] of Object.entries(def.extra_body)) {
        if (!(k in extraBody)) extraBody[k] = v;
      }
      log.info('defaults applied', { engine: engineName, keys: Object.keys(def.extra_body) });
    }
  }

  // ── Voice + speed ───────────────────────────────────────────────────────
  let voiceName = voice ?? 'default';
  // Clients sometimes send speed as a string ("1") — coerce; MiniMax batch
  // rejects float-typed fields sent as strings with a 2013 param error.
  let speed = speedInput != null ? Number(speedInput) : undefined;
  if (speed != null && Number.isNaN(speed)) {
    throw Object.assign(
      new Error(`invalid speed: ${JSON.stringify(speedInput)}`),
      { status: 400, type: 'invalid_request' },
    );
  }

  // ── Preset (Node-managed voice configuration) ───────────────────────────
  if (engineName) {
    const found = presets.lookup(engineName, voiceName);
    if (found) {
      log.info('preset resolved', { engine: engineName, preset: voiceName, to: found.voice });
      voiceName = found.voice;
      if (found.instructions) instructions = found.instructions;
      if (found.speed != null) speed = found.speed;
      if (found.extra_body) Object.assign(extraBody, found.extra_body);
    }
  }

  // ── Voice validation (final voice, before any engine work) ──────────────
  await assertVoiceValid({ engineName, voiceName });

  return { engine, subModel, engineName, voiceName, speed, instructions, extraBody };
}
