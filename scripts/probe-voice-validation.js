/**
 * Probe: request-time voice validation (issue #5).
 *
 * The failure being fixed: a Kokoro-style name sent to ElevenLabs ('Kimi') left
 * nSpeech as a provider round-trip and came back as the provider's 404 after the
 * caller had committed text and a render slot. Now the provider is known at the
 * request, so the rejection happens there.
 *
 * Checks:
 *   A. Structural — ElevenLabs ids are 20 alnum; anything else is a 404.
 *   B. Membership — engines whose catalogue nSpeech owns (gemini, local) reject
 *      a name that is not in the list, naming valid ids.
 *   C. No false rejections — a real id for each checked engine passes.
 *   D. Sentinel and unknown-engine paths are untouched (engine default, no
 *      catalogue → the request proceeds).
 *
 * Offline: only the voice cache is read (disk snapshot / static lists). No
 * provider call happens for any engine this probe touches.
 *
 * Run: node scripts/probe-voice-validation.js
 */
import { assertVoiceValid } from '../server/voice-validation.js';

let failures = 0;

function report(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function rejects(label, opts, expectMatch) {
  try {
    await assertVoiceValid(opts);
    report(label, false, 'accepted (expected 404)');
  } catch (err) {
    const ok = err.status === 404 && err.code === 'voice_not_found'
      && (!expectMatch || err.message.includes(expectMatch));
    report(label, ok, `${err.status}/${err.code}: ${err.message.slice(0, 120)}`);
  }
}

async function accepts(label, opts) {
  try {
    await assertVoiceValid(opts);
    report(label, true);
  } catch (err) {
    report(label, false, `${err.status}/${err.code}: ${err.message.slice(0, 120)}`);
  }
}

// ── A. Structural (ElevenLabs) ─────────────────────────────────────────────
await rejects('elevenlabs: "Kimi" (the reported case) → 404',
  { engineName: 'elevenlabs', voiceName: 'Kimi' }, '20-character alphanumeric');
await rejects('elevenlabs: "eleven_v3" (a model id, not a voice) → 404',
  { engineName: 'elevenlabs', voiceName: 'eleven_v3' }, '20-character alphanumeric');
await accepts('elevenlabs: 20-char premade id passes shape check',
  { engineName: 'elevenlabs', voiceName: '21m00Tcm4TlvDq8ikWAM' });
await accepts('elevenlabs: 20-char cloned id passes shape check',
  { engineName: 'elevenlabs', voiceName: 'pNInz6obpgDQGcFmaJgB' });

// ── B. Catalogue membership ────────────────────────────────────────────────
await rejects('gemini: "Nope" → 404 listing valid voices',
  { engineName: 'gemini', voiceName: 'Nope' }, 'Valid voices:');
await rejects('gemini: a Kokoro voice name → 404',
  { engineName: 'gemini', voiceName: 'af_heart' }, 'Valid voices:');
await rejects('kokoro: unknown voice → 404 listing valid voices',
  { engineName: 'kokoro', voiceName: 'definitely_not_a_voice' }, 'Valid voices:');

// ── C. No false rejections on real voices ──────────────────────────────────
await accepts('gemini: "Puck" passes', { engineName: 'gemini', voiceName: 'Puck' });
await accepts('kokoro: "af_heart" passes', { engineName: 'kokoro', voiceName: 'af_heart' });

// ── D. Sentinel / unverifiable paths ───────────────────────────────────────
await accepts('sentinel "default" is never validated', { engineName: 'kokoro', voiceName: 'default' });
await accepts('omitted voice is never validated', { engineName: 'elevenlabs', voiceName: undefined });
await accepts('empty voice is never validated', { engineName: 'gemini', voiceName: '' });
await accepts('unknown engine name skips validation', { engineName: null, voiceName: 'anything' });
await accepts('elevenlabs has no membership check (personal-only listing)',
  { engineName: 'elevenlabs', voiceName: 'AAAAAAAAAAAAAAAAAAAA' });
await accepts('minimax is not shape-checked (unverified id rules)',
  { engineName: 'minimax', voiceName: 'Kimi' });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
