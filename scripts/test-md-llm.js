/** Probe: run cleanMarkdownLLM against a real markdown file.
 * Usage: node scripts/test-md-llm.js <input.md> [output.txt]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanMarkdownLLM, cleanMarkdown } from '../server/markdown-clean.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/test-md-llm.js <input.md> [output.txt]');
  process.exit(1);
}

const text = readFileSync(resolve(input), 'utf8');

console.log(`Input: ${input} (${text.length} chars)`);
console.log('--- Regex path (for comparison) ---');
const t0 = performance.now();
const regexOut = cleanMarkdown(text);
console.log(`Regex: ${regexOut.length} chars in ${Math.round(performance.now() - t0)}ms`);

console.log('--- LLM path ---');
const t1 = performance.now();
const llmOut = await cleanMarkdownLLM(text);
console.log(`LLM: ${llmOut.length} chars in ${Math.round(performance.now() - t1)}ms`);

const out = process.argv[3] ?? 'logs/md-llm-test-output.txt';
writeFileSync(out, llmOut);
console.log(`LLM output written to ${out}`);
