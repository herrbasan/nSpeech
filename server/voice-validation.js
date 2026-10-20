/**
 * Request-time voice validation (issue #5).
 *
 * nSpeech is the component that knows which provider a request resolved to and
 * what that provider accepts — the caller is not. Before this module, a bad
 * voice was discovered at synthesis time: a Kokoro voice name sent to
 * ElevenLabs came back as the provider's own 404 after the caller had committed
 * a text, a render slot, and (for cloud) latency. A stale name in a client's
 * saved voice mapping therefore surfaced mid-batch, not at the request.
 *
 * Two checks, deliberately different in strength:
 *
 *   1. STRUCTURAL — the id cannot be valid for this provider, by the provider's
 *      own id shape. Only asserted where the shape was verified against the live
 *      API in this repo, because a wrong shape is a false rejection of a working
 *      voice. ElevenLabs: 20 alphanumeric characters (all 70 ids returned by
 *      GET /v2/voices on 2026-10-20 matched, across premade/professional/
 *      cloned/generated).
 *
 *   2. CATALOG MEMBERSHIP — the id is not in the provider's voice list. Only
 *      applied where nSpeech's own listing IS the provider's authoritative set:
 *      local engines (disk scan mirroring the worker's rules) and Gemini (static
 *      prebuilt list). ElevenLabs is excluded on purpose: its adapter lists
 *      `voice_type=personal` only (26 of the 49 ids the API returns), so
 *      membership would reject the 21 premade voices that synthesise fine.
 *      Cloud providers whose lists are account-scoped stay on the existing path:
 *      the adapter already maps their 404 to `voice_not_found`.
 *
 * Status is 404 `voice_not_found` for both, not 400: that is the documented
 * contract since issue #1 ("a bad voice is always a 404, never a 500 or an
 * empty 200") and the code the SDK's VoiceNotFoundError keys on.
 *
 * Fail-open is bounded and traced: an empty catalog means the listing missed
 * (never warmed, engine unreachable) and proves nothing, so the request proceeds
 * to the engine with a warning instead of rejecting every voice.
 */
import * as voiceCache from './voice-cache.js';
import { WorkerError } from './engine/worker.js';
import { logger } from './logger.js';

const log = logger.child('voice');

/** Engines whose voice list nSpeech itself defines — membership is authoritative. */
const CATALOG_AUTHORITATIVE = new Set([
  'gemini',
  'kokoro',
  'f5tts',
  'f5tts-german',
  'chatterbox-turbo',
  'vibevoice',
]);

/** Provider id shapes verified against the live API — see the module docblock. */
const STRUCTURAL = {
  elevenlabs: {
    pattern: /^[A-Za-z0-9]{20}$/,
    describe: 'a 20-character alphanumeric voice_id',
  },
};

/** `voice: 'default'` / omitted is the documented engine-default sentinel. */
function isSentinel(voiceName) {
  return voiceName == null || voiceName === '' || voiceName === 'default';
}

/**
 * Throw a typed 404 when the voice cannot be served by the resolved engine.
 *
 * @param {object} opts
 * @param {string|null} opts.engineName — canonical engine name (engineNameFor)
 * @param {string} opts.voiceName — final voice, after defaults and preset resolution
 * @returns {Promise<void>} — resolves when the voice is acceptable or unverifiable
 */
export async function assertVoiceValid({ engineName, voiceName }) {
  if (!engineName || isSentinel(voiceName)) return;

  const shape = STRUCTURAL[engineName];
  if (shape && !shape.pattern.test(voiceName)) {
    throw new WorkerError(404, 'voice_not_found',
      `Voice ${JSON.stringify(voiceName)} is not a valid ${engineName} voice: expected ${shape.describe}.`);
  }

  if (!CATALOG_AUTHORITATIVE.has(engineName)) return;

  let voices = await _catalog(engineName);
  if (!voices.length) {
    log.warn('voice catalogue empty — membership not checked', { engine: engineName, voice: voiceName });
    return;
  }

  if (_has(voices, voiceName)) return;

  // One authoritative re-read before rejecting: a voice cloned seconds ago is
  // already refreshed by the mutation hook, but a listing that landed before
  // warm-up can still be behind. Nothing here spawns a worker.
  voices = await voiceCache.invalidate(engineName).then(r => r.voices ?? []).catch(() => voices);
  if (!voices.length || _has(voices, voiceName)) return;

  const ids = voices.map(v => v.voice_id ?? v.name).filter(Boolean);
  const shown = ids.slice(0, 25).join(', ') + (ids.length > 25 ? `, … (${ids.length} total)` : '');
  throw new WorkerError(404, 'voice_not_found',
    `Voice ${JSON.stringify(voiceName)} is not served by ${engineName}. Valid voices: ${shown}`);
}

async function _catalog(engineName) {
  try {
    const { voices } = await voiceCache.get(engineName);
    return voices ?? [];
  } catch (err) {
    // Boundary tolerance with a trace: an unreachable provider listing must not
    // turn a synthesis request into a 500.
    log.warn('voice catalogue unavailable — membership not checked',
      { engine: engineName, error: err.message });
    return [];
  }
}

function _has(voices, voiceName) {
  return voices.some(v => (v.voice_id ?? v.name) === voiceName);
}
