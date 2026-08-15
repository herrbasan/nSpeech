/**
 * Direct alignment probe against a manually started STT worker.
 * Usage: node scripts/align-probe.js <port> <chunkN>
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIR = resolve(ROOT, 'logs/stitch-ghost');

const port = process.argv[2];
const n = parseInt(process.argv[3], 10);
if (!port || !Number.isInteger(n)) { console.error('usage: align-probe.js <port> <chunkN>'); process.exit(1); }

const pcm = readFileSync(resolve(DIR, `chunk-${n}.pcm`));
const text = readFileSync(resolve(DIR, `chunk-${n}.txt`), 'utf8');
const overlap = readFileSync(resolve(DIR, `chunk-${n}.overlap.txt`), 'utf8');
const overlapWords = overlap.trim().split(/\s+/).filter(Boolean).length;
const prefixSec = Math.min(pcm.length / 48000, (overlapWords / 2.6) * 1.6 + 8);
const prefixBytes = Math.round(prefixSec * 24000) * 2;
const words = text.trim().split(/\s+/).slice(0, overlapWords + 25).join(' ');

const p = pcm.subarray(0, prefixBytes);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + p.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(p.length, 40);
const wav = Buffer.concat([h, p]);

const boundary = '----probe' + Date.now();
const parts = [
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
  wav,
  Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n`),
  Buffer.from(words),
  Buffer.from(`\r\n--${boundary}--\r\n`),
];

const t0 = Date.now();
const r = await fetch(`http://127.0.0.1:${port}/v1/audio/align`, {
  method: 'POST',
  headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  body: Buffer.concat(parts),
});
const j = await r.json();
const dt = ((Date.now() - t0) / 1000).toFixed(1);
if (!r.ok) { console.error('HTTP', r.status, JSON.stringify(j).slice(0, 200)); process.exit(1); }
const bw = j.words[overlapWords];
console.log(`port ${port}: chunk ${n} prefix ${prefixSec.toFixed(1)}s aligned in ${dt}s | boundary ${JSON.stringify(bw.word)} @ ${bw.start.toFixed(3)}s`);
process.exit(0);
