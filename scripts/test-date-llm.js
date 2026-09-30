/**
 * One-shot check of the LLM date pass against the live local gateway.
 *   node scripts/test-date-llm.js
 * Read-only: one generation call per sentence, no server touched.
 */
'use strict';

const { cleanMarkdownLLM } = await import('../server/markdown-clean.js');

const CASES = [
  'Wir treffen uns am 12. September um 9 Uhr.',
  'Der 3. Oktober ist ein Feiertag. Am 24.12.2026 endet das Projekt.',
  'On September 12, 2026, the deal closes. We ship May 11 and June 12.',
  'This sentence has no dates at all and must come back unchanged.',
];

for (const text of CASES) {
  try {
    const out = await cleanMarkdownLLM(text);
    console.log(`IN : ${text}\nOUT: ${out}\n`);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  }
}
console.log('date pass live check done');
