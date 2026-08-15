/**
 * Generate one fixture chunk from a saved text file.
 * Reads logs/stitch-ghost/chunk-N.txt, calls ElevenLabs directly,
 * writes chunk-N.pcm + chunk-N.wav into logs/stitch-ghost/.
 *
 * Usage: node scripts/gen-fixture-chunk.js <N>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIR = resolve(ROOT, 'logs/stitch-ghost');

function loadEnv() {
  const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function pcmToWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const n = parseInt(process.argv[2], 10);
if (!Number.isInteger(n) || n < 0) { console.error('usage: gen-fixture-chunk.js <N>'); process.exit(1); }

const text = readFileSync(resolve(DIR, `chunk-${n}.txt`), 'utf8');
const voice = 'tLz0KTPteAXd06XSE8k3';
const model = 'eleven_v3';

loadEnv();
const { ElevenLabsAdapter } = await import(pathToFileURL(resolve(ROOT, 'server/cloud/elevenlabs.js')).href);
const real = new ElevenLabsAdapter();

console.log(`GENERATING chunk ${n} — ${text.length} chars, voice ${voice}, model ${model}`);
const t0 = Date.now();
const stream = await real.generatePcmStream({
  text,
  voice_name: voice,
  speed: 1.0,
  instruct_text: undefined,
  extra_body: { batch: true },
  model,
});

const parts = [];
const hb = setInterval(() => {
  const s = Math.round((Date.now() - t0) / 1000);
  const got = parts.reduce((a, p) => a + p.length, 0);
  console.log(`  …${s}s elapsed${got ? `, ${(got / 48000).toFixed(1)}s audio` : ', no bytes yet'}`);
}, 15000);
try {
  for await (const p of stream) parts.push(p);
} finally {
  clearInterval(hb);
}
const pcm = Buffer.concat(parts);
if (pcm.length === 0) throw new Error('empty audio returned');

writeFileSync(resolve(DIR, `chunk-${n}.pcm`), pcm);
writeFileSync(resolve(DIR, `chunk-${n}.wav`), pcmToWav(pcm));
console.log(`saved chunk-${n}.pcm/.wav (${pcm.length} bytes = ${(pcm.length / 48000).toFixed(1)}s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
