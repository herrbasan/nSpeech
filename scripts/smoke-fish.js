/** Smoke: FishAdapter.generatePcmStream + listVoices against the live API. Run: node scripts/smoke-fish.js */
import { FishAdapter } from '../server/cloud/fish.js';
import { writeFileSync, readFileSync } from 'node:fs';

// Minimal .env loader (script runs outside the server)
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const eq = line.indexOf('=');
  if (eq > 0 && !line.trim().startsWith('#')) {
    const k = line.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = line.slice(eq + 1).trim();
  }
}

const ad = new FishAdapter();
console.log('health:', ad.health());

const voices = await ad.listVoices();
console.log('voices:', voices.voices.length);

const t0 = Date.now();
const stream = await ad.generatePcmStream({
  text: 'Hallo! This is a Fish Audio S2 smoke test through nSpeech. [whispers] Can you hear the difference?',
  voice_name: null,
  speed: 1.0,
  model: 's2.1-pro-free',
});
let bytes = 0, firstByteMs = null;
const chunks = [];
for await (const chunk of stream) {
  if (firstByteMs === null) firstByteMs = Date.now() - t0;
  bytes += chunk.length;
  chunks.push(Buffer.from(chunk));
}
// Wrap in a WAV header for auditioning
const pcm = Buffer.concat(chunks);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
writeFileSync('logs/smoke-fish.wav', Buffer.concat([header, pcm]));
const durSec = (Date.now() - t0) / 1000;
// s16le mono 24kHz → 48000 bytes/sec
const audioSec = bytes / 48000;
console.log(`bytes=${bytes} audioSec=${audioSec.toFixed(1)} wallSec=${durSec.toFixed(1)} rtFactor=${(audioSec / durSec).toFixed(1)}x ttfb=${firstByteMs}ms`);
console.log('OK — audio at logs/smoke-fish.wav');
