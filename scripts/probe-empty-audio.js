/**
 * Probe: `peekFirstAudioChunk` — the fail-fast guard for empty audio (issue #1).
 *
 * A 200 with a 0-byte body is indistinguishable from success for the caller, so
 * emptiness must become a status code before the response is committed. The
 * peek must therefore be:
 *   - lossless     (no byte dropped or duplicated, order preserved)
 *   - complete     (null only when the stream really held no audio)
 *   - transparent  (errors propagate; the same stream is handed back, so the
 *                   relay's destroy()-on-disconnect still stops the engine)
 *
 * Run: node scripts/probe-empty-audio.js
 */
import { Readable } from 'node:stream';
import { peekFirstAudioChunk } from '../server/api/speech.js';

let failures = 0;

function report(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const EMPTY = Buffer.alloc(0);
const A = Buffer.from('aaaa');
const B = Buffer.from('bb');

/** Readable that yields the given chunks, optionally failing after them. */
function makeStream(chunks, errorAfter) {
  return Readable.from((async function* () {
    for (const c of chunks) yield c;
    if (errorAfter) throw errorAfter;
  })());
}

async function collect(stream) {
  const out = [];
  for await (const c of stream) out.push(c);
  return Buffer.concat(out);
}

// ── 1. lossless, order preserved, empty leading chunks skipped ─────────────
{
  const source = makeStream([EMPTY, A, B]);
  const peeked = await peekFirstAudioChunk(source);
  report('1. first non-empty chunk is returned', peeked.firstChunk?.equals(A) === true,
    `got ${peeked.firstChunk?.toString()}`);
  report('1. the same stream is handed back', peeked.stream === source);
  const rest = await collect(peeked.stream);
  report('1. no byte dropped or duplicated', rest.equals(Buffer.concat([A, B])),
    `got ${JSON.stringify(rest.toString())} want ${JSON.stringify(Buffer.concat([A, B]).toString())}`);
}

// ── 2. no audio at all ────────────────────────────────────────────────────
{
  const empty = await peekFirstAudioChunk(makeStream([]));
  report('2. empty stream → firstChunk null', empty.firstChunk === null && empty.stream === null);

  const allEmpty = await peekFirstAudioChunk(makeStream([EMPTY, EMPTY]));
  report('2. only-empty-chunks stream → firstChunk null',
    allEmpty.firstChunk === null && allEmpty.stream === null);
}

// ── 3. errors surface, before and after the first chunk ───────────────────
{
  const boom = new Error('engine fell over');
  let caught = null;
  try {
    await peekFirstAudioChunk(makeStream([], boom));
  } catch (err) {
    caught = err;
  }
  report('3. error before any audio propagates to the caller', caught === boom,
    caught ? String(caught.message) : 'no error');

  const peeked = await peekFirstAudioChunk(makeStream([A], boom));
  let midCaught = null;
  try {
    await collect(peeked.stream);
  } catch (err) {
    midCaught = err;
  }
  report('3. error after the first chunk still reaches the consumer', midCaught === boom,
    midCaught ? String(midCaught.message) : 'no error');
}

// ── 4. rejection of a non-Readable source ─────────────────────────────────
{
  let caught = null;
  try {
    await peekFirstAudioChunk((async function* () { yield A; })());
  } catch (err) {
    caught = err;
  }
  report('4. a plain async iterable is rejected loudly',
    caught instanceof Error && /Node Readable/.test(caught.message),
    caught ? String(caught.message) : 'no error');
}

// ── 5. destroying the returned stream cancels the engine ──────────────────
{
  let destroyed = false;
  const src = new Readable({
    read() {},
    destroy(err, cb) { destroyed = true; cb(err); },
  });
  src.push(A);
  const peeked = await peekFirstAudioChunk(src);
  report('5. peek found the chunk', peeked.firstChunk?.equals(A) === true);
  peeked.stream.destroy();
  await new Promise(r => setImmediate(r));
  report('5. destroying the returned stream destroys the engine stream', destroyed,
    destroyed ? '' : 'engine left generating after a disconnect');
}

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
