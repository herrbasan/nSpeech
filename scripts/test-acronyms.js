/** Test: acronym expansion for TTS readability.
 * Usage: node scripts/test-acronyms.js
 */
import { expandAcronyms } from '../server/markdown-clean.js';

const cases = [
  ['I talked to GLM5 today', 'I talked to G L M five today'],
  ['Kimi K3 was paired with Claude.', 'Kimi K three was paired with Claude.'],
  ['an RTX 4090 GPU', 'an R T X 4090 G P U'],
  ['RLHF, DPO, and MMLU scores', 'R L H F, D P O, and M M L U scores'],
  ['CUDA on NASA hardware', 'CUDA on NASA hardware'],           // pronounced as words
  ['F5-TTS engine', 'F five T T S engine'],                      // hyphen → space, TTS spelled
  ['the API key', 'the A P I key'],
  ['GPT4 vs GPT-4', 'G P T four vs G P T-4'],
  ['2026 and 4090 stay numeric', '2026 and 4090 stay numeric'],
  ['see religion.md for the docs', 'see religion dot m d for the docs'],
  ['config.json and main.ts', 'config dot j s o n and main dot t s'],
  ['render-f5tts.py output.wav', 'render-f5tts dot p y output dot w a v'],
];

let pass = 0;
for (const [input, expect] of cases) {
  const got = expandAcronyms(input);
  const ok = got === expect;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input)}\n      → ${JSON.stringify(got)}${ok ? '' : `\n      expected ${JSON.stringify(expect)}`}`);
}
console.log(`\n${pass}/${cases.length} passed`);
