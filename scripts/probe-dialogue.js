/**
 * Probe: dialogue mode end to end, offline — zero provider calls, zero spend.
 *
 *   node scripts/probe-dialogue.js [--file <path-to-md>]
 *
 * Covers:
 *   1. MD-Blocks v1.8 narration extraction (happy path + every §3/§7/§5.2
 *      failure that could make a turn list untrustworthy)
 *   2. cast resolution (registry, override, recast, unbound)
 *   3. edge-silence trimming and gap assembly arithmetic
 *   4. the route with a fake engine: turn count, gap/pause timing, turn cache
 *      (miss → hit → identical bytes), estimate_only (no engine call), the
 *      empty-audio failure, and the persisted manifest
 *
 * With `--file`, the given document is parsed too — point it at a real post to
 * check the grammar against real content (the blog draft lives in the storage
 * box; copy it locally first).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { config } from '../server/config.js';
import { parseDialogue } from '../server/dialogue-parse.js';
import * as cast from '../server/dialogue-cast.js';
import * as renderCache from '../server/render-cache.js';
import { relayDialogue } from '../server/api/dialogue.js';
import { trimEdgeSilence, silence, durationMs, SAMPLE_RATE } from '../server/dialogue-audio.js';

const ROOT = resolve(import.meta.dirname, '..');
// The fixture lives under scripts/ because `tests/` is gitignored (large audio
// fixtures) — a probe that only works on the author's machine is not a probe.
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'dialogue-two-speakers.md');
const SCRATCH = join(tmpdir(), `nspeech-dialogue-probe-${Date.now()}`);

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
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function near(actual, expected, tolerance, what) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${what}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

function failsWith(src, code, what) {
  let err = null;
  try { parseDialogue(src, { file: 'probe.md' }); } catch (e) { err = e; }
  if (!err) throw new Error(`${what}: expected an error with code ${code}, parsed clean`);
  eq(err.code, code, `${what} (message: ${err.message})`);
  return err;
}

// A synthetic tone: non-silent, so the edge trim keeps it, and cheap.
function tone(ms) {
  const samples = Math.round(ms * SAMPLE_RATE / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 300 * i / SAMPLE_RATE) * 0.3 * 32767), i * 2);
  }
  return buf;
}

function fakeEngine({ ms = 100, empty = false } = {}) {
  const calls = [];
  return {
    calls,
    maxChars: Infinity,
    async generatePcmStream(args) {
      calls.push(args);
      if (empty) return Readable.from([Buffer.alloc(0)]);
      return Readable.from([tone(ms)]);
    },
  };
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    headers: {},
    payload: null,
    hijacked: false,
    raw: new EventEmitter(),
    code(c) { reply.statusCode = c; return reply; },
    type() { return reply; },
    header(k, v) { reply.headers[k] = v; return reply; },
    send(p) { reply.payload = p; return reply; },
    hijack() { reply.hijacked = true; },
  };
  reply.raw.destroyed = false;
  return reply;
}

/** Run the route with a fake engine bound to every turn. */
async function render(markdown, { engine, engineName = 'fake', gapMs, responseFormat = 'wav', castOverride } = {}) {
  const captures = [];
  const deps = {
    async resolveParams({ model, voice, speed, extra_body }) {
      captures.push({ model, voice, speed, extra_body: { ...extra_body } });
      return {
        engine,
        subModel: model,
        engineName,
        voiceName: voice,
        speed,
        instructions: undefined,
        extraBody: extra_body,
      };
    },
  };
  const reply = fakeReply();
  await relayDialogue({}, reply, {
    source: { markdown, file: 'probe.md' },
    ...(gapMs !== undefined ? { gap_ms: gapMs } : {}),
    ...(castOverride ? { cast: castOverride } : {}),
    response_format: responseFormat,
  }, deps);
  return { reply, captures };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Setup
// ═══════════════════════════════════════════════════════════════════════════

mkdirSync(SCRATCH, { recursive: true });
config.dialogue.cache.dir = join(SCRATCH, 'cache');
config.dialogue.gapMs = 400;

const fixtureSrc = readFileSync(FIXTURE, 'utf8');
const fixture = parseDialogue(fixtureSrc, { file: 'two-speakers.md' });
const fixtureTurns = fixture.items.filter((i) => i.type === 'turn');
const fixtureBeats = fixture.items.filter((i) => i.type === 'beat');

// ═══════════════════════════════════════════════════════════════════════════
//  1. Extraction
// ═══════════════════════════════════════════════════════════════════════════

check('fixture: 4 turns, 3 beats, source order', () => {
  eq(fixtureTurns.length, 4, 'turn count');
  eq(fixtureBeats.length, 3, 'beat count');
  eq(fixture.items.map((i) => (i.type === 'turn' ? i.speaker : `beat:${i.seconds}`)).join(','),
    'david-a-renelt,beat:1.5,kimi-k3,david-a-renelt,beat:0.75,kimi-k3,beat:0.5', 'order');
});

check('fixture: speakers and display names', () => {
  eq(fixture.speakers.map((s) => `${s.id}:${s.name}:${s.turns}`).join('|'),
    'david-a-renelt:David:2|kimi-k3:Kimi K3:2', 'speakers');
});

check('fixture: prose and cards are not turns', () => {
  const all = fixtureTurns.map((t) => t.markdown).join('\n');
  if (all.includes('A framed card')) throw new Error('card block leaked into the turns');
  if (all.includes('Prose outside')) throw new Error('prose leaked into the turns');
});

check('fixture: fenced code inside a turn is content, not structure', () => {
  const last = fixtureTurns[3];
  if (!last.markdown.includes('preset=narration:nobody')) {
    throw new Error('fenced directive text was swallowed — it must stay body content');
  }
});

check('fixture: a data: attribute parses and is ignored', () => {
  eq(fixtureTurns[3].speaker, 'kimi-k3', 'speaker unaffected by data:scene');
});

check('fixture: quoted string values and JSON values parse', () => {
  const doc = `<p>x</p>
<!-- mb:block preset=narration:alice name="Alice A." label="Opening" data:focal={"x":0.5,"y":0.3} -->
Hello.
<!-- mb:/block -->`;
  const parsed = parseDialogue(doc, { file: 'attr.md' });
  eq(parsed.speakers[0].name, 'Alice A.', 'quoted name with space');
});

check('§3: duplicate attribute is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a id=x id=y -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'duplicate key');
});

check('§3: unknown bare attribute is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a speaker=b -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'unknown bare key');
});

check('§3: unknown namespace prefix is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a foo:bar=1 -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'unknown prefix');
});

check('§3: raw > inside a value is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a name="a > b" -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'raw angle');
});

check('§3: malformed JSON value is an error, not a string', () => {
  failsWith(`<!-- mb:block preset=narration:a weights=[2,1 -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'malformed JSON');
});

check('§7: name on a non-narration block is an error', () => {
  failsWith(`<!-- mb:block preset=card:note name="X" -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'name on card');
});

check('§7: empty name is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a name="" -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'empty name');
});

check('§5.2: conflicting display names for one speaker is an error', () => {
  const err = failsWith([
    '<!-- mb:block preset=narration:a name="Alice" -->', 'One.', '<!-- mb:/block -->',
    '<!-- mb:block preset=narration:a name="Alicia" -->', 'Two.', '<!-- mb:/block -->',
  ].join('\n'), 'dialogue_speaker_conflict', 'name conflict');
  if (!/line 1/.test(err.message)) throw new Error(`conflict must cite both locations: ${err.message}`);
});

check('§5.2: bare narration (no speaker) is an error', () => {
  failsWith(`<!-- mb:block preset=narration -->\nHi\n<!-- mb:/block -->`, 'dialogue_no_speaker', 'bare narration');
});

check('§5.1: a third preset segment is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a:b -->\nHi\n<!-- mb:/block -->`, 'dialogue_preset_invalid', 'variant segment');
});

check('§5.2: audio= on a narration block is an error (would re-bill a recording)', () => {
  failsWith(`<!-- mb:block preset=narration:a audio=renders/a.mp3 -->\nHi\n<!-- mb:/block -->`, 'dialogue_audio_recorded', 'audio attribute');
});

check('§4.2: nested block is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a -->\nHi\n<!-- mb:block preset=card -->\nx\n<!-- mb:/block -->`, 'md_blocks_syntax', 'nested block');
});

check('§4.2: unclosed block is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a -->\nHi\n`, 'md_blocks_syntax', 'unclosed block');
});

check('§4.2: stray /block is an error', () => {
  failsWith(`<!-- mb:/block -->`, 'md_blocks_syntax', 'stray close');
});

check('§4.2: a marker inside a block is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a -->\nHi\n<!-- mb:section -->\n<!-- mb:/block -->`, 'md_blocks_syntax', 'marker in block');
});

check('§4.5: mb:/main is an error', () => {
  failsWith(`<!-- mb:/main -->\n<!-- mb:block preset=narration:a -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', '/main');
});

check('§2: an unknown mb: kind is an error', () => {
  failsWith(`<!-- mb:blokc preset=narration:a -->\nHi`, 'md_blocks_syntax', 'unknown kind');
});

check('§4.3: col outside columns, and a single-column columns block', () => {
  failsWith(`<!-- mb:col -->\n<!-- mb:block preset=narration:a -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'stray col');
  failsWith([
    '<!-- mb:columns -->', '<!-- mb:col -->',
    '<!-- mb:block preset=narration:a -->', 'Hi', '<!-- mb:/block -->',
    '<!-- mb:/columns -->',
  ].join('\n'), 'md_blocks_syntax', 'one column');
});

check('pause: malformed, zero, and inside a turn all fail', () => {
  failsWith(`<!-- pause: soon -->\n<!-- mb:block preset=narration:a -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'malformed beat');
  failsWith(`<!-- pause: 0 -->\n<!-- mb:block preset=narration:a -->\nHi\n<!-- mb:/block -->`, 'md_blocks_syntax', 'zero beat');
  failsWith(`<!-- mb:block preset=narration:a -->\n<!-- pause: 1 -->\nHi\n<!-- mb:/block -->`, 'dialogue_beat_in_turn', 'beat in turn');
});

check('empty narration body is an error', () => {
  failsWith(`<!-- mb:block preset=narration:a -->\n\n<!-- mb:/block -->`, 'dialogue_empty_turn', 'empty body');
});

check('a document with no narration blocks is an error', () => {
  failsWith(`# Just prose\n\nNo turns here.`, 'dialogue_no_turns', 'no turns');
});

check('setext trap: `---` under a paragraph line is not a section break', () => {
  // If it were treated as a break, the second mb:section would be legal.
  failsWith([
    '<!-- mb:section -->', 'A paragraph', '---',
    '<!-- mb:section -->',
    '<!-- mb:block preset=narration:a -->', 'Hi', '<!-- mb:/block -->',
  ].join('\n'), 'md_blocks_syntax', 'setext then second section');
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Cast
// ═══════════════════════════════════════════════════════════════════════════

const registryFile = join(SCRATCH, 'cast.json');
writeFileSync(registryFile, JSON.stringify({
  alice: { model: 'eleven_v4', voice_id: 'alice-voice', settings: { stability: 0.4, speed: 1.05 } },
  bob: { engine: 'minimax', voice_id: 'bob-voice' },
}, null, 2));

check('cast: registry binding resolves engine, model, settings', () => {
  cast._useFile(registryFile);
  const b = cast.resolveSpeaker('alice');
  eq(b.engine, 'elevenlabs', 'engine');
  eq(b.model, 'eleven_v4', 'model');
  eq(b.voice_id, 'alice-voice', 'voice');
  eq(b.settings.stability, 0.4, 'settings inherited');
  eq(b.source, 'registry', 'source');
});

check('cast: a bare engine resolves to that provider', () => {
  eq(cast.resolveSpeaker('bob').engine, 'minimax', 'engine');
  eq(cast.resolveSpeaker('bob').model, 'minimax', 'model selector');
});

check('cast: an override wins and inherits settings when the engine is unchanged', () => {
  const b = cast.resolveSpeaker('alice', { alice: { voice_id: 'other-voice' } });
  eq(b.voice_id, 'other-voice', 'voice from cast');
  eq(b.settings.stability, 0.4, 'settings kept');
  eq(b.source, 'cast', 'source');
});

check('cast: recasting to another engine drops the old engine\'s settings', () => {
  const b = cast.resolveSpeaker('alice', { alice: { model: 'minimax_speech_2_8_hd', voice_id: 'mm-voice' } });
  eq(b.engine, 'minimax', 'engine');
  eq(Object.keys(b.settings).length, 0, 'settings dropped');
});

check('cast: an unbound speaker fails loudly and names the id', () => {
  let err = null;
  try { cast.resolveSpeaker('nobody'); } catch (e) { err = e; }
  if (!err) throw new Error('expected an error');
  eq(err.status, 400, 'status');
  eq(err.code, 'dialogue_speaker_unbound', 'code');
  if (!err.message.includes('nobody')) throw new Error(`message must name the id: ${err.message}`);
});

check('cast: invalid entries fail loudly', () => {
  const badOverrides = [
    [{}, 'an empty override'],
    [{ model: 'eleven_v4', voice_id: '' }, 'empty voice_id'],
    [{ model: 'eleven_v4', voice_id: 'x', voice: 'y' }, 'unknown key'],
    [{ model: 'eleven_v4', voice_id: 'x', settings: [] }, 'settings must be an object'],
  ];
  for (const [entry, what] of badOverrides) {
    let threw = false;
    try { cast.resolveSpeaker('alice', { alice: entry }); } catch { threw = true; }
    if (!threw) throw new Error(`expected a failure for: ${what}`);
  }
  // Registry entries are complete bindings, so a missing selector is fatal.
  let threw = false;
  try { cast.validateEntry({ voice_id: 'x' }, 'registry'); } catch { threw = true; }
  if (!threw) throw new Error('expected a failure for a registry entry with no model/engine');
  threw = false;
  try { cast.validateEntry({ model: 'eleven_v4' }, 'registry'); } catch { threw = true; }
  if (!threw) throw new Error('expected a failure for a registry entry with no voice_id');
});

check('cast: model/engine disagreement is an error', () => {
  let err = null;
  try { cast.resolveSpeaker('alice', { alice: { model: 'eleven_v4', engine: 'minimax', voice_id: 'x' } }); }
  catch (e) { err = e; }
  if (!err) throw new Error('expected an error');
  eq(err.code, 'dialogue_binding_invalid', 'code');
});

cast._useFile(join(ROOT, 'dialogue-cast.json'));

// ═══════════════════════════════════════════════════════════════════════════
//  3. Audio edges
// ═══════════════════════════════════════════════════════════════════════════

check('audio: silence() is sample-exact', () => {
  eq(silence(400).length, 400 * 24 * 2, 'bytes');
  eq(silence(1.5).length, 36 * 2, 'fractional ms');
});

check('audio: edge silence is trimmed, a guard is kept, edges are faded', () => {
  const padded = Buffer.concat([Buffer.alloc(silence(300).length), tone(200), silence(300)]);
  const out = trimEdgeSilence(padded);
  if (!out) throw new Error('expected a trimmed buffer');
  near(out.leadMs, 280, 25, 'leading trim');
  near(out.tailMs, 280, 25, 'trailing trim');
  near(durationMs(out.pcm), 200 + 40, 30, 'kept duration');
  eq(Math.abs(out.pcm.readInt16LE(0)) < 100, true, 'first sample faded');
});

check('audio: a silent buffer is not assemblable', () => {
  eq(trimEdgeSilence(silence(500)), null, 'all-silence');
  eq(trimEdgeSilence(Buffer.alloc(0)), null, 'empty');
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. Route
// ═══════════════════════════════════════════════════════════════════════════

const fakeCast = {
  'david-a-renelt': { model: 'eleven_v4', voice_id: 'david-voice' },
  'kimi-k3': { model: 'eleven_v4', voice_id: 'kimi-voice' },
};

let firstRun;

await checkAsync('route: renders every turn, gaps and beats assemble', async () => {
  const engine = fakeEngine({ ms: 100 });
  firstRun = await render(fixtureSrc, { engine, castOverride: fakeCast });
  eq(firstRun.reply.statusCode, 200, 'status');
  eq(engine.calls.length, 4, 'engine calls');
  eq(firstRun.reply.headers['X-Dialogue-Turns'], '4', 'turn header');
  const master = firstRun.reply.payload;
  // 4×100ms turns + beat 1.5s + default gap 0.4s + beat 0.75s + trailing beat 0.5s
  near(durationMs(master), 400 + 1500 + 400 + 750 + 500, 3, 'master duration');
});

await checkAsync('route: the manifest on disk names every turn', async () => {
  const id = firstRun.reply.headers['X-Dialogue-Id'];
  const manifest = JSON.parse(readFileSync(join(config.dialogue.cache.dir, `${id}.manifest.json`), 'utf8'));
  eq(manifest.status, 'ok', 'status');
  eq(manifest.turns.length, 4, 'turn records');
  eq(manifest.gap_ms, 400, 'gap');
  near(manifest.totals.audio_ms, 3550, 3, 'totals.audio_ms');
  eq(manifest.totals.bytes > 0, true, 'totals.bytes');
  eq(manifest.turns.filter((t) => t.cache === 'miss').length, 4, 'first run writes every turn');
});

await checkAsync('route: the second identical run is served from the turn cache', async () => {
  const engine = fakeEngine({ ms: 100 });
  const second = await render(fixtureSrc, { engine, castOverride: fakeCast });
  eq(engine.calls.length, 0, 'engine calls on a full cache hit');
  eq(second.reply.headers['X-Dialogue-Cache'], '4/4 hit', 'cache header');
  eq(Buffer.compare(second.reply.payload, firstRun.reply.payload), 0, 'identical master');
});

await checkAsync('route: gap_ms replaces the default gap everywhere', async () => {
  const engine = fakeEngine({ ms: 100 });
  // Cache entries are keyed on audio, not on the gap, so this is all hits.
  const run = await render(fixtureSrc, { engine, gapMs: 1000, castOverride: fakeCast });
  near(durationMs(run.reply.payload), 400 + 1500 + 1000 + 750 + 500, 3, 'master duration with gap 1000');
});

await checkAsync('route: estimate_only calls no engine and counts chars per speaker', async () => {
  const engine = fakeEngine();
  const reply = fakeReply();
  await relayDialogue({}, reply, {
    source: { markdown: fixtureSrc, file: 'probe.md' },
    cast: fakeCast,
    estimate_only: true,
  }, {
    async resolveParams() { throw new Error('estimate must not resolve generation params'); },
  });
  eq(engine.calls.length, 0, 'engine calls');
  eq(reply.payload.turns, 4, 'turns');
  eq(reply.payload.pauses.count, 3, 'pauses');
  const alice = reply.payload.speakers.find((s) => s.id === 'david-a-renelt');
  eq(alice.engine, 'elevenlabs', 'speaker engine');
  eq(alice.binding, 'cast', 'binding source');
  const total = reply.payload.speakers.reduce((n, s) => n + s.chars, 0);
  eq(total, reply.payload.engines.reduce((n, e) => n + e.chars, 0), 'engine chars match speaker chars');
});

await checkAsync('route: an engine that renders nothing fails before any byte is sent', async () => {
  const engine = fakeEngine({ empty: true });
  // A distinct document, or every turn would be served from the cache above.
  const run = await render(fixtureSrc.replace('Fourth turn.', 'Fourth turn (empty).'), { engine, castOverride: fakeCast });
  eq(run.reply.statusCode, 502, 'status');
  eq(run.reply.payload?.error?.code, 'empty_audio', 'code');
  eq(run.reply.headers['X-Dialogue-Id'] !== undefined, true, 'manifest id on the failure path');
});

await checkAsync('route: an engine that renders silence is a failure, not a silent turn', async () => {
  const silent = { calls: [], maxChars: Infinity, async generatePcmStream() { return Readable.from([silence(200)]); } };
  const run = await render(fixtureSrc.replace('Fourth turn.', 'Fourth turn (silent).'), { engine: silent, castOverride: fakeCast });
  eq(run.reply.statusCode, 502, 'status');
  eq(run.reply.payload?.error?.code, 'empty_audio', 'code');
});

await checkAsync('route: an unbound speaker fails before any render', async () => {
  const engine = fakeEngine();
  const withGhost = fixtureSrc.replace(
    '<!-- pause: 0.5 -->',
    '<!-- mb:block preset=narration:ghost name="Ghost" -->\nBoo.\n<!-- mb:/block -->\n\n<!-- pause: 0.5 -->',
  );
  const run = await render(withGhost, { engine, castOverride: fakeCast });
  eq(run.reply.statusCode, 400, 'status');
  eq(run.reply.payload?.error?.code, 'dialogue_speaker_unbound', 'code');
  if (!run.reply.payload.error.message.includes('ghost')) {
    throw new Error(`the error must name the unbound id: ${run.reply.payload.error.message}`);
  }
  eq(engine.calls.length, 0, 'engine calls');
});

await checkAsync('route: reply context is sent to a capable engine, per turn', async () => {
  const engine = fakeEngine({ ms: 50 });
  const run = await render(fixtureSrc, { engine, engineName: 'elevenlabs', castOverride: fakeCast });
  eq(run.reply.statusCode, 200, 'status');
  const [first, second] = run.captures;
  eq(first.extra_body.previous_text, undefined, 'first turn has no previous');
  if (!first.extra_body.next_text) throw new Error('first turn should carry next_text');
  if (!second.extra_body.previous_text) throw new Error('second turn should carry previous_text');
  eq(second.extra_body.previous_text.length <= 500, true, 'previous_text window');
  eq(second.extra_body.next_text.length <= 250, true, 'next_text window');
});

await checkAsync('route: an edited turn re-renders with its context neighbours', async () => {
  // Reply context is part of a turn's audio, so editing one turn also
  // invalidates the turns whose previous_text/next_text point at it: the last
  // turn's edit re-renders 2 turns, a middle turn's edit re-renders 3.
  const editedLast = fixtureSrc.replace('Fourth turn.', 'Fourth turn, edited.');
  const lastEngine = fakeEngine({ ms: 100 });
  const lastRun = await render(editedLast, { engine: lastEngine, castOverride: fakeCast });
  eq(lastEngine.calls.length, 2, 'edited last turn + its predecessor');
  eq(lastRun.reply.headers['X-Dialogue-Cache'], '2/4 hit', 'cache header (last turn)');

  const editedMiddle = fixtureSrc.replace('Second turn,', 'Second turn, revised,');
  const midEngine = fakeEngine({ ms: 100 });
  const midRun = await render(editedMiddle, { engine: midEngine, castOverride: fakeCast });
  eq(midEngine.calls.length, 3, 'edited middle turn + both neighbours');
  eq(midRun.reply.headers['X-Dialogue-Cache'], '1/4 hit', 'cache header (middle turn)');
  eq(midRun.captures.length, 4, 'every turn still resolved');
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. Optional real document
// ═══════════════════════════════════════════════════════════════════════════

const fileArgIndex = process.argv.indexOf('--file');
if (fileArgIndex !== -1 && process.argv[fileArgIndex + 1]) {
  const path = resolve(process.argv[fileArgIndex + 1]);
  check(`real document parses: ${path}`, () => {
    const parsed = parseDialogue(readFileSync(path, 'utf8'), { file: path });
    const turns = parsed.items.filter((i) => i.type === 'turn');
    const beats = parsed.items.filter((i) => i.type === 'beat');
    if (turns.length === 0) throw new Error('no turns');
    for (const t of turns) {
      if (!t.speaker) throw new Error(`turn ${t.index} has no speaker`);
    }
    console.log(`      ${turns.length} turns, ${beats.length} beats, speakers: ` +
      parsed.speakers.map((s) => `${s.id}${s.name ? ` (${s.name})` : ''} ×${s.turns}`).join(', '));
    const alternations = turns.slice(1).filter((t, i) => t.speaker !== turns[i].speaker).length;
    console.log(`      speaker switches: ${alternations}/${turns.length - 1}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
