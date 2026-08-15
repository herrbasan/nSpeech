/**
 * Offline stitch-test harness — exercises generateChunkedBatch without
 * touching the ElevenLabs API. A fake engine replays PCM from files on disk;
 * nVoice alignment (live at http://192.168.0.100:2244) does the trimming.
 *
 * Usage:
 *   node scripts/test-stitch-offline.js parts.txt       — split + dump parts
 *   node scripts/test-stitch-offline.js stitch out.wav  — run batch stitch
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { splitIntoChunks } = await import(pathToFileURL(resolve(ROOT, 'server/chunking.js')).href);
const { Readable } = await import('node:stream');

// ── Fake engine: replays PCM from files on disk, counts generate calls ────
// TRUTHFUL fixtures (2026-08-14): each chunk's audio speaks exactly the text
// the real engine would receive — chunk1-real = paras 0-8, aligntext-real =
// overlap para 8 + paras 9-10. Both Kokoro-generated (free, local).
const PCM_DIR = resolve(ROOT, 'logs/chunk-test/parts');
let callCount = 0;

const fakeEngine = {
  maxChars: 4800,
  async generatePcmStream({ text }) {
    const idx = callCount++;
    if (idx === 0) {
      const pcm = readFileSync(resolve(PCM_DIR, 'chunk1-real.pcm'));
      console.log(`  [fake-engine] call #0 — ${text.length} chars → ${pcm.length} bytes (chunk 1, truthful)`);
      return Readable.from([pcm]);
    }
    // Chunk 2: truthful audio = spoken overlap + spoken content, with the
    // natural 300ms paragraph gap baked into the Kokoro generation.
    const pcm = readFileSync(resolve(PCM_DIR, 'aligntext-real.pcm'));
    console.log(`  [fake-engine] call #1 — ${text.length} chars → ${pcm.length} bytes (chunk 2 = overlap+content, truthful)`);
    return Readable.from([pcm]);
  },
};

// ── WAV writer: wrap s16le PCM in a 24kHz mono WAV header ─────────────────
function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(24000, 24);   // 24kHz
  header.writeUInt32LE(48000, 28);   // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ── Mode: split — show how text splits into chunks + overlaps ─────────────
if (process.argv[2] === 'split') {
  const text = readFileSync(resolve(ROOT, 'logs/chunk-test/input-text.txt'), 'utf8');
  const chunks = splitIntoChunks(text, 4800);
  console.log(`input: ${text.length} chars → ${chunks.length} chunks`);
  chunks.forEach((c, i) => {
    const paras = c.text.split(/\n\s*\n/).filter(Boolean);
    console.log(`  chunk ${i + 1}: ${c.text.length} chars, ${paras.length} paras — "${c.text.slice(0, 60).replace(/\n/g, ' ')}..."`);
  });
  process.exit(0);
}

// ── Mode: stitch — run generateChunkedBatch with the fake engine ──────────
if (process.argv[2] === 'stitch') {
  const outFile = process.argv[3] ?? resolve(ROOT, 'logs/chunk-test/C-stitched-offline.wav');
  console.log('offline stitch test — fake engine + local stt worker (MMS forced alignment)');

  const { generateChunkedBatch } = await import(pathToFileURL(resolve(ROOT, 'server/chunking.js')).href);

  // Full 5752-char text → 2 chunks → overlap = last para of chunk 1
  const text = readFileSync(resolve(ROOT, 'logs/chunk-test/input-text.txt'), 'utf8');
  const stream = await generateChunkedBatch({
    text,
    engine: fakeEngine,
    voiceName: 'test',
    speed: 1.0,
    instructions: undefined,
    extraBody: {},
    subModel: 'eleven_v3',
  });

  const parts = [];
  for await (const part of stream) parts.push(part);
  const pcm = Buffer.concat(parts);
  console.log(`\nstitched: ${pcm.length} bytes PCM (${(pcm.length / 48000).toFixed(1)}s at 24kHz)`);
  writeFileSync(outFile, pcmToWav(pcm));
  console.log(`written: ${outFile}`);
  process.exit(0);
}

console.error('usage: node scripts/test-stitch-offline.js [split|stitch]');
process.exit(1);
