/**
 * Date-pronunciation experiment — MiniMax German.
 *
 * Renders each VARIANT below as its own MP3 into logs/date-variants/ so the
 * human ear can pick the winner. The server must be running. No restarts
 * needed between runs — edit variants, re-run, listen.
 *
 *   node scripts/test-date-variants.js
 *
 * Voice is a top-level config — change it if Melon_DE isn't what you use.
 */
'use strict';

import { mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

// ── config ──────────────────────────────────────────────────────────────────
const BASE_URL = 'http://127.0.0.1:2233';
const MODEL = 'minimax';
const VOICE = 'Melon_DE';          // German cloned voice; change if needed
const OUT_DIR = 'logs/date-variants';

// Each variant: [label, { input, extraBody }]
const SENTENCE = 'Wir treffen uns am 12. September um 9 Uhr.';
const VARIANTS = [
  ['1-baseline',        { input: SENTENCE }],
  ['2-no-dot',          { input: SENTENCE.replace('12.', '12') }],
  ['3-ordinal-spelled', { input: SENTENCE.replace('12.', 'zwölften').replace('9 Uhr', 'neun Uhr') }],
  ['4-pron-dict',       { input: SENTENCE, eb: { pronunciation: { tone: ['12./zwölften', '9/neun'] } } }],
  ['5-lang-de',         { input: SENTENCE, eb: { language: 'de' } }],
  // LLM date pass (server): dates → fully spoken words with correct grammar.
  // Needs the local gateway; compare 1↔6 by ear for the pause + declension fix.
  ['6-llm-date-pass',   { input: SENTENCE, eb: { clean: 'llm', language: 'de' } }],
];

// ── render ──────────────────────────────────────────────────────────────────
await mkdir(OUT_DIR, { recursive: true });

for (const [label, { input, eb = {} }] of VARIANTS) {
  const body = {
    model: MODEL,
    input,
    voice: VOICE,
    response_format: 'mp3',
    extra_body: { batch: true, ...eb },
  };
  const res = await fetch(`${BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error(`FAIL ${label}: HTTP ${res.status} — ${detail.slice(0, 200)}`);
    process.exit(1);
  }
  const file = `${OUT_DIR}/${label}.mp3`;
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log(`ok   ${file}  ← ${JSON.stringify(input)}${Object.keys(eb).length ? `  eb=${JSON.stringify(eb)}` : ''}`);
}

console.log(`\nDone — listen in ${OUT_DIR}/ (${basename(process.argv[1])})`);
