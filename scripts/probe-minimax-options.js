/**
 * Probe: MiniMax request options, offline — no provider call, no spend.
 *
 *   node scripts/probe-minimax-options.js
 *
 * Covers:
 *   1. buildRequestBody — every option the dashboard exposes lands in the
 *      provider's own shape, and the wire format flips to WAV exactly when
 *      voice_modify is used (MiniMax rejects it on PCM — probed 2026-10-24).
 *   2. Range/enum enforcement — clamped numbers leave a trace, invalid enums
 *      fail before the round-trip.
 *   3. RIFF/WAVE header stripping (including an extra chunk before `data`).
 *   4. Defaults key normalisation — the bug that made cloud dial-ins inert:
 *      the dashboard sends a model slug, the relay looks up the engine name.
 */
import { join } from 'node:path';

import { buildRequestBody, wavDataOffset, stripWav } from '../server/cloud/minimax.js';
import { engineKey } from '../server/api/defaults.js';
import { engineNameFor } from '../server/engine/manager.js';

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

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

function near(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

function throwsCode(fn, status, what) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`${what}: expected a throw`);
  if (status !== undefined) near(err.status, status, `${what} (message: ${err.message})`);
  return err;
}

const BASE = { text: 'Hello.', voice_name: 'English_trustworth_man', speed: 1, extra_body: {} };

// ── 1. Wire format ─────────────────────────────────────────────────────────
check('default request is raw PCM', () => {
  const { body, format } = buildRequestBody(BASE);
  eq(format, 'pcm', 'wire format');
  eq(body.audio_setting.format, 'pcm', 'audio_setting.format');
  eq(body.voice_modify, undefined, 'no voice_modify');
  eq(body.stream, true, 'streaming by default');
  eq(body.stream_options, { exclude_aggregated_audio: true }, 'stream options');
});

check('voice_modify flips the request to a buffered WAV render', () => {
  const { body, format } = buildRequestBody({ ...BASE, extra_body: { voice_modify: { intensity: -30 } } });
  eq(format, 'wav', 'wire format');
  eq(body.audio_setting.format, 'wav', 'audio_setting.format');
  eq(body.voice_modify, { intensity: -30 }, 'voice_modify');
  // Probed 2026-10-24: voice_modify in stream mode only accepts mp3, so the
  // adapter drops to a buffered render and keeps the WAV/PCM contract.
  eq(body.stream, false, 'streaming disabled');
  eq(body.stream_options, undefined, 'no stream_options');
});

check('batch mode drops streaming and its options', () => {
  const { body } = buildRequestBody({ ...BASE, extra_body: { batch: true } });
  eq(body.stream, false, 'stream');
  eq(body.stream_options, undefined, 'stream_options');
});

// ── 2. Options land in the provider shape ──────────────────────────────────
check('voice_setting carries voice, speed, vol, pitch, emotion', () => {
  const { body } = buildRequestBody({
    ...BASE, speed: 1.4,
    extra_body: { vol: 2.5, pitch: -6, emotion: 'calm' },
  });
  eq(body.voice_setting.voice_id, 'English_trustworth_man', 'voice');
  eq(body.voice_setting.speed, 1.4, 'speed');
  eq(body.voice_setting.vol, 2.5, 'vol');
  eq(body.voice_setting.pitch, -6, 'pitch');
  eq(body.voice_setting.emotion, 'calm', 'emotion');
});

check('voice_setting defaults are explicit, never undefined', () => {
  const { body } = buildRequestBody(BASE);
  eq(body.voice_setting.vol, 1, 'vol default');
  eq(body.voice_setting.pitch, 0, 'pitch default');
});

check('timbre_weights come from extra_body.blend', () => {
  const { body } = buildRequestBody({
    ...BASE, extra_body: { blend: [{ voice_id: 'a', weight: 70 }, { voice_id: 'b' }] },
  });
  eq(body.timbre_weights, [{ voice_id: 'a', weight: 70 }, { voice_id: 'b', weight: 50 }], 'timbre_weights');
});

check('text_normalization_mode passes through; legacy boolean maps to basic', () => {
  eq(buildRequestBody({ ...BASE, extra_body: { text_normalization_mode: 'quality' } }).body.text_normalization_mode, 'quality', 'quality');
  eq(buildRequestBody({ ...BASE, extra_body: { text_normalization: true } }).body.text_normalization_mode, 'basic', 'legacy true');
  eq(buildRequestBody({ ...BASE, extra_body: { text_normalization: false } }).body.text_normalization_mode, undefined, 'legacy false');
});

check('language ISO code maps to the provider boost name', () => {
  eq(buildRequestBody({ ...BASE, extra_body: { language: 'de' } }).body.language_boost, 'German', 'de');
  // MiniMax's enum has an `auto` member (unlike ElevenLabs, where the field
  // must be omitted), so the literal is forwarded.
  eq(buildRequestBody({ ...BASE, extra_body: { language: 'auto' } }).body.language_boost, 'auto', 'auto forwarded');
  eq(buildRequestBody(BASE).body.language_boost, undefined, 'unset stays unset');
});

check('subtitles and latex_read still map', () => {
  const { body } = buildRequestBody({ ...BASE, extra_body: { subtitles: 'word', latex_read: true } });
  eq(body.subtitle_enable, true, 'subtitle_enable');
  eq(body.subtitle_type, 'word', 'subtitle_type');
  eq(body.voice_setting.latex_read, true, 'latex_read');
});

check('the "default" voice sentinel never reaches the provider', () => {
  eq(buildRequestBody({ ...BASE, voice_name: 'default' }).body.voice_setting.voice_id, 'English_expressive_narrator', 'sentinel');
  eq(buildRequestBody({ ...BASE, voice_name: '' }).body.voice_setting.voice_id, 'English_expressive_narrator', 'empty');
});

check('model override is honoured', () => {
  eq(buildRequestBody({ ...BASE, model: 'speech-2.8-hd' }).body.model, 'speech-2.8-hd', 'model');
  eq(buildRequestBody(BASE).body.model, 'speech-2.8-turbo', 'default model');
});

// ── 3. Ranges and enums ────────────────────────────────────────────────────
check('out-of-documented-range numbers are clamped', () => {
  // MiniMax ACCEPTS pitch 13 silently (probed 2026-10-24), so the clamp is the
  // only thing standing between a client and an undocumented value.
  eq(buildRequestBody({ ...BASE, extra_body: { pitch: 13 } }).body.voice_setting.pitch, 12, 'pitch high');
  eq(buildRequestBody({ ...BASE, extra_body: { pitch: -20 } }).body.voice_setting.pitch, -12, 'pitch low');
  eq(buildRequestBody({ ...BASE, extra_body: { vol: 20 } }).body.voice_setting.vol, 10, 'vol high');
  eq(buildRequestBody({ ...BASE, speed: 3 }).body.voice_setting.speed, 2, 'speed high');
  eq(buildRequestBody({ ...BASE, extra_body: { voice_modify: { intensity: 250 } } }).body.voice_modify.intensity, 100, 'intensity');
});

check('sound_effects enum is enforced locally', () => {
  const err = throwsCode(() => buildRequestBody({ ...BASE, extra_body: { voice_modify: { sound_effects: 'nope' } } }), 400, 'bad effect');
  if (!/spacious_echo/.test(err.message)) throw new Error(`message must list the valid set: ${err.message}`);
});

check('text_normalization_mode enum is enforced locally', () => {
  throwsCode(() => buildRequestBody({ ...BASE, extra_body: { text_normalization_mode: 'nonsense' } }), 400, 'bad mode');
});

check('flattened aliases still work (old clients)', () => {
  const { body } = buildRequestBody({ ...BASE, extra_body: { intensity: 10, timbre: -10, sound_effects: 'robotic' } });
  eq(body.voice_modify, { intensity: 10, timbre: -10, sound_effects: 'robotic' }, 'voice_modify');
});

// ── 4. RIFF/WAVE stripping ─────────────────────────────────────────────────
function riff(extraChunk = false) {
  const pcm = Buffer.alloc(64, 0x11);
  const chunks = [];
  // A real WAV opens with `fmt ` — included so the fixture exercises the
  // chunk-walking loop rather than assuming the data payload starts at 44.
  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);   // PCM
  fmt.writeUInt16LE(1, 10);  // mono
  fmt.writeUInt32LE(24000, 12);
  fmt.writeUInt32LE(48000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  chunks.push(fmt);
  if (extraChunk) {
    const list = Buffer.alloc(8 + 10);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(10, 4);
    chunks.push(list);
  }
  const data = Buffer.alloc(8 + pcm.length);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(pcm.length, 4);
  pcm.copy(data, 8);
  chunks.push(data);
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WAVE', 8, 'ascii');
  return { buf: Buffer.concat([head, body]), pcm };
}

check('WAV data offset found (plain and with a leading chunk)', () => {
  const plain = riff(false);
  eq(wavDataOffset(plain.buf), 44, 'plain offset');
  eq(Buffer.compare(stripWav(plain.buf), plain.pcm), 0, 'plain payload');

  const extra = riff(true);
  // 12 RIFF head + (8+16) fmt + (8+10) LIST = 54 → data header at 54, payload at 62.
  eq(wavDataOffset(extra.buf), 62, 'offset past LIST');
  eq(Buffer.compare(stripWav(extra.buf), extra.pcm), 0, 'payload past LIST');
});

check('a partial header reports "need more", a bad magic fails loud', () => {
  const { buf } = riff(false);
  eq(wavDataOffset(buf.subarray(0, 10)), -1, 'incomplete header');
  const bad = Buffer.from(buf);
  bad.write('MThd', 0, 'ascii');
  throwsCode(() => wavDataOffset(bad), undefined, 'bad magic');
});

check('a header with no data chunk is an error, not silence', () => {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.write('WAVE', 8, 'ascii');
  throwsCode(() => stripWav(head), undefined, 'no data chunk');
});

// ── 5. Defaults key normalisation ──────────────────────────────────────────
check('defaults: a cloud model slug resolves to its engine', () => {
  eq(engineKey('minimax_speech_2_8_turbo'), 'minimax', 'minimax slug');
  eq(engineKey('minimax_speech_2_8_hd'), 'minimax', 'minimax hd slug');
  eq(engineKey('eleven_v3'), 'elevenlabs', 'eleven v3');
  eq(engineKey('elevenlabs_turbo_v2_5'), 'elevenlabs', 'legacy alias');
  eq(engineKey('fish_s2_pro'), 'fish', 'fish');
});

check('defaults: bare engine names pass through unchanged', () => {
  eq(engineKey('minimax'), 'minimax', 'minimax');
  eq(engineKey('f5tts'), 'f5tts', 'f5tts');
  eq(engineKey('bogus'), 'bogus', 'unknown stays itself so it simply matches nothing');
});

check('defaults: the relay and the route agree on the key', () => {
  for (const probe of ['minimax_speech_2_8_turbo', 'eleven_v3', 'f5tts', 'fish_s2_pro']) {
    near(engineKey(probe), engineNameFor(probe), `engineKey(${probe}) vs engineNameFor`);
  }
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
