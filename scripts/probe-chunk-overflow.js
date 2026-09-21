/**
 * Probe: does the chunk planner ever emit a chunk over maxChars?
 *
 * Issue #3 — the overlap prefix is prepended on top of a chunk that may have
 * been filled to the full maxChars, so the emitted request can exceed the
 * budget the caller asked for (and the engine's hard limit).
 *
 * Two checks:
 *   A. Deterministic mechanism repro — engineered text that fills a chunk to
 *      exactly maxChars, with a long preceding paragraph as the overlap.
 *   B. Random-article sweep — measure how often a real-shaped article triggers
 *      it, and by how much it overflows.
 *   C. Real corpus — the Ghost-article stitch fixture, which recorded an
 *      over-budget chunk on 2026-08-15.
 *
 * Run: node scripts/probe-chunk-overflow.js
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildChunkRequests, splitIntoChunks } from '../server/chunking.js';

let failures = 0;

function report(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── A. Deterministic mechanism repro ───────────────────────────────────────
// maxChars 100. Chunk 1 fills to exactly 100 (P1 50 + join 2 + P2 48).
// Chunk 2's base also fills to exactly 100 (P3). Chunk 2's overlap is P2 (48).
// Emitted chunk 2 text = 48 + 2 + 100 = 150 — over the 100 budget.
const MAX = 100;
const text = 'x'.repeat(50) + '\n\n' + 'y'.repeat(48) + '\n\n' + 'z'.repeat(100);

const rawChunks = splitIntoChunks(text, MAX);
console.log('A. splitIntoChunks chunk sizes:', rawChunks.map(c => c.text.length).join(', '));

const requests = buildChunkRequests(text, MAX, { overlapParagraphs: 1 });
console.log('A. emitted request sizes:    ', requests.map(r => r.text.length).join(', '));
console.log('A. overlap sizes:            ', requests.map(r => r.overlapText.length).join(', '));

const over = requests.filter(r => r.text.length > MAX);
report('A. no emitted chunk exceeds maxChars',
  over.length === 0,
  over.length ? `${over.length}/${requests.length} over (max ${Math.max(...requests.map(r => r.text.length))} vs ${MAX})` : '');

// ── B. Random-article sweep ────────────────────────────────────────────────
// Paragraph lengths in the range seen in real articles (~150-700 chars).
// MiniMax profile from the production log: maxChars 9800 (engine hard limit
// 10000 — 200 chars of headroom).
const ENGINE_MAX = 9800;
const HARD_LIMIT = 10000;

function randomArticle(targetChars, rnd) {
  const paras = [];
  let total = 0;
  while (total < targetChars) {
    // Paragraph lengths, skewed toward the short end like real prose.
    const len = 150 + Math.floor(Math.pow(rnd(), 1.6) * 700);
    const words = [];
    let l = 0;
    while (l < len) {
      const w = 'abcdefghijklmnop'.slice(0, 3 + Math.floor(rnd() * 9));
      words.push(w);
      l += w.length + 1;
    }
    const para = words.join(' ').slice(0, len);
    paras.push(para);
    total += para.length + 2;
  }
  return paras.join('\n\n');
}

// Deterministic PRNG so the probe is reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const TRIALS = 2000;
let trialsOverBudget = 0;
let trialsOverHardLimit = 0;
let worstOver = 0;
let totalChunks = 0;

for (let t = 0; t < TRIALS; t++) {
  const rnd = makeRng(1234 + t);
  const article = randomArticle(23440, rnd);
  const reqs = buildChunkRequests(article, ENGINE_MAX, { overlapParagraphs: 1 });
  totalChunks += reqs.length;

  const maxLen = Math.max(...reqs.map(r => r.text.length));
  if (maxLen > ENGINE_MAX) {
    trialsOverBudget++;
    worstOver = Math.max(worstOver, maxLen - ENGINE_MAX);
  }
  if (maxLen > HARD_LIMIT) trialsOverHardLimit++;
}

console.log('');
console.log(`B. ${TRIALS} random ~23.4K-char articles, ${totalChunks} chunks total`);
console.log(`B. over maxChars (${ENGINE_MAX}):     ${trialsOverBudget} articles (${(trialsOverBudget / TRIALS * 100).toFixed(1)}%)`);
console.log(`B. over engine hard limit (${HARD_LIMIT}): ${trialsOverHardLimit} articles (${(trialsOverHardLimit / TRIALS * 100).toFixed(1)}%)`);
console.log(`B. worst overflow past maxChars:  ${worstOver} chars`);
console.log('B. NOTE: these paragraph lengths (150-850 chars) leave smaller gaps than the');
console.log('B.       real corpus, so this is a STRESS model, not a production rate.');
console.log('B.       Production logged 10 stitch plans, 1 over budget (2026-09-20).');

report('B. no emitted chunk exceeds maxChars (2000 articles)',
  trialsOverBudget === 0,
  trialsOverBudget ? `${trialsOverBudget} article(s) affected` : '');

// ── C. Real corpus — the Ghost-article stitch fixture ──────────────────────
// tests/stitch-ghost/ holds the 4 real chunks captured 2026-08-15 from the
// Ghost article (14,123 chars) with the pre-fix planner at maxChars 4800.
// Chunk 2 of that capture is 5112 chars — 312 over budget — so the fixture
// itself is a recorded instance of the bug on real text.
//
// Rebuild the source article from the fixture, re-plan it, and assert the
// invariant. Also assert no content is lost or duplicated.
const FIX_DIR = resolve(import.meta.dirname, '../tests/stitch-ghost');
const norm = s => s.replace(/\s+/g, ' ').trim();

const fixtureChunks = [0, 1, 2, 3].map(n => {
  const text = readFileSync(resolve(FIX_DIR, `chunk-${n}.txt`), 'utf8');
  if (n === 0) return { text, content: text, overlap: '' };
  const overlap = readFileSync(resolve(FIX_DIR, `chunk-${n}.overlap.txt`), 'utf8');
  if (!text.startsWith(overlap)) {
    throw new Error(`fixture shape changed: chunk-${n}.txt does not start with chunk-${n}.overlap.txt`);
  }
  return { text, content: text.slice(overlap.length).replace(/^\s+/, ''), overlap };
});

console.log('');
console.log('C. Ghost fixture (real capture, 2026-08-15, maxChars 4800):');
console.log(`C. recorded sizes: ${fixtureChunks.map(c => c.text.length).join(', ')}`);
const recordedOver = fixtureChunks.filter(c => c.text.length > 4800);
console.log(`C. recorded over-budget chunks: ${recordedOver.length}` +
  (recordedOver.length ? ` (max ${Math.max(...fixtureChunks.map(c => c.text.length))})` : ''));

const article = fixtureChunks.map(c => c.content).join('\n\n');
const replanned = buildChunkRequests(article, 4800, { overlapParagraphs: 1 });
console.log(`C. re-planned sizes:  ${replanned.map(r => r.text.length).join(', ')}`);

const replanOver = replanned.filter(r => r.text.length > 4800);
report('C. no re-planned chunk exceeds maxChars',
  replanOver.length === 0,
  replanOver.length ? `max ${Math.max(...replanned.map(r => r.text.length))}` : '');

const rebuilt = replanned.map(r => r.text.slice(r.overlapText.length).replace(/^\s+/, '')).join(' ');
report('C. no content lost or duplicated by re-planning',
  norm(rebuilt) === norm(article),
  norm(rebuilt) === norm(article) ? '' :
    `${norm(article).length} → ${norm(rebuilt).length} chars`);

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
