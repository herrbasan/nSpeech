/**
 * Probe: is the chunk gate model-aware?
 *
 * Issue #6 — `relaySpeech` decided whether to chunk with `shouldChunk(text, engine)`,
 * which read the fixed `engine.maxChars`. On ElevenLabs that is 9600 (the DEFAULT
 * model, eleven_v4_turbo), while the planner splits against `getMaxChars(subModel)`
 * (eleven_v3: 4800). Text in (4800, 9600] therefore skipped chunking and was sent
 * as one request, killed by the provider with `text_too_long` after the fact.
 *
 * Checks:
 *   A. Model-aware gate — the same text is chunked or not depending on the model.
 *   B. Gate/planner agreement — when the gate says "chunk", the plan must exist and
 *      every emitted request must fit the same limit (#3's invariant).
 *   C. Non-model-aware and unlimited engines behave exactly as before.
 *   D. Legacy two-argument call still resolves to the default model's limit.
 *
 * Run: node scripts/probe-chunk-gate.js
 */
import { shouldChunk, maxCharsFor, buildChunkRequests } from '../server/chunking.js';

let failures = 0;

function report(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// Mirrors ElevenLabsAdapter: fixed maxChars = default model, model-aware getMaxChars.
const elevenlabs = {
  get maxChars() { return 9600; },
  getMaxChars(model) {
    const limits = {
      eleven_v4: 10000, eleven_v4_turbo: 10000, eleven_v3: 5000,
      eleven_multilingual_v2: 10000, eleven_flash_v2_5: 40000,
    };
    return Math.floor((limits[model] ?? limits.eleven_v4_turbo) * 0.96);
  },
};

// Synthetic article with paragraph structure, so the planner has real boundaries.
function article(chars) {
  const para = 'Dies ist ein Satz mit genug Text, um eine Absatzgrenze zu bilden. ';
  const paras = [];
  for (let n = 0; paras.join('\n\n').length < chars; n++) {
    paras.push(`${n}. ${para.repeat(3)}`);
  }
  return paras.join('\n\n').slice(0, chars);
}

// The exact shape that failed live: 8616 chars, eleven_v3, mode:'stitch'.
const DE_8616 = article(8616);

// ── A. Model-aware gate ────────────────────────────────────────────────────
const v3Limit = elevenlabs.getMaxChars('eleven_v3');   // 4800
const v4Limit = elevenlabs.getMaxChars('eleven_v4_turbo'); // 9600

report('eleven_v3 limit is 4800', v3Limit === 4800, String(v3Limit));
report('eleven_v4_turbo limit is 9600', v4Limit === 9600, String(v4Limit));

report('8616 chars on eleven_v3 → chunk',
  shouldChunk(DE_8616, elevenlabs, 'eleven_v3') === true);
report('8616 chars on eleven_v4_turbo → no chunk (under 9600)',
  shouldChunk(DE_8616, elevenlabs, 'eleven_v4_turbo') === false);

report('4800 chars on eleven_v3 → no chunk (at the limit)',
  shouldChunk('x'.repeat(4800), elevenlabs, 'eleven_v3') === false);
report('4801 chars on eleven_v3 → chunk (one over)',
  shouldChunk('x'.repeat(4801), elevenlabs, 'eleven_v3') === true);
report('9601 chars on eleven_v4_turbo → chunk',
  shouldChunk('x'.repeat(9601), elevenlabs, 'eleven_v4_turbo') === true);

// The reported live failure mode: 5091 chars was luck, 8616 was the 400.
report('5091 chars on eleven_v3 → chunk (the "shrank below 5000 by luck" case)',
  shouldChunk('x'.repeat(5091), elevenlabs, 'eleven_v3') === true);

// ── B. Gate/planner agreement ──────────────────────────────────────────────
// Whatever the gate decides, the plan uses the same limit — no window where the
// request is over the engine's limit but under the gate's.
{
  const maxChars = maxCharsFor(elevenlabs, 'eleven_v3');
  const requests = buildChunkRequests(DE_8616, maxChars, { overlapParagraphs: 1 });
  const over = requests.filter(r => r.text.length > maxChars);
  report('8616 chars on eleven_v3 plans ≥2 chunks', requests.length >= 2,
    `chunks ${requests.length}, sizes ${requests.map(r => r.text.length).join(', ')}`);
  report('every planned request fits the gate limit', over.length === 0,
    over.length ? `over: ${over.map(r => r.text.length).join(', ')}` : '');
  report('gate limit matches planner limit', maxChars === v3Limit, String(maxChars));
}

// A text the gate leaves unchunked must be under the engine limit by construction.
for (const [model, limit] of [['eleven_v3', v3Limit], ['eleven_v4_turbo', v4Limit]]) {
  const text = 'x'.repeat(limit);
  const gate = shouldChunk(text, elevenlabs, model);
  report(`${model}: at-limit text is not chunked and not over the engine limit`,
    gate === false && text.length <= limit, gate ? 'chunked' : 'not chunked');
}

// ── C. Non-model-aware / unlimited engines ─────────────────────────────────
const minimax = { get maxChars() { return 9800; } };
report('minimax 9800 → no chunk', shouldChunk('x'.repeat(9800), minimax, 'x') === false);
report('minimax 9801 → chunk', shouldChunk('x'.repeat(9801), minimax, 'x') === true);

const f5tts = { get maxChars() { return Infinity; } };
report('unlimited engine never chunks (f5tts maxChars Infinity)',
  shouldChunk('x'.repeat(500000), f5tts, null) === false);

// ── D. Legacy two-argument call ────────────────────────────────────────────
// Must still resolve to the default model's limit, matching the old maxChars read.
report('two-arg call uses the default-model limit (9600, not 4800)',
  shouldChunk('x'.repeat(8616), elevenlabs) === false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
