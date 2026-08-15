/**
 * Live smoke test: POST /v1/audio/align + /v1/audio/transcriptions through
 * the running nSpeech server (port 2233). Spawns the stt worker lazily.
 */
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:2233';
const WAV = readFileSync('D:/DEV/nSpeech/logs/chunk-test/parts/probe-12s.wav');
const TEXT = 'A data model fixed. Each choice is a door closing.';

function multipart(fields) {
  const boundary = `----smoke${Date.now()}`;
  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"${f.filename ? `; filename="${f.filename}"` : ''}\r\n${f.filename ? 'Content-Type: audio/wav\r\n' : ''}\r\n`));
    parts.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ── align ──
const a = multipart([
  { name: 'file', value: WAV, filename: 'audio.wav' },
  { name: 'text', value: TEXT },
]);
let t0 = Date.now();
let r = await fetch(`${BASE}/v1/audio/align`, { method: 'POST', headers: { 'content-type': a.contentType }, body: a.body });
let j = await r.json();
console.log(`align: HTTP ${r.status} in ${Date.now() - t0}ms (includes worker spawn)`);
if (r.ok) {
  console.log(`  words: ${j.words.length} | duration: ${j.duration}s`);
  console.log('  first 3:', j.words.slice(0, 3).map(w => `${w.word}@${w.start}`).join(', '));
} else {
  console.log('  error:', JSON.stringify(j).slice(0, 300));
}

// ── transcriptionsGerman check on English audio (auto-detect) ──
const tr = multipart([
  { name: 'file', value: WAV, filename: 'audio.wav' },
  { name: 'word_timestamps', value: 'true' },
]);
t0 = Date.now();
r = await fetch(`${BASE}/v1/audio/transcriptions`, { method: 'POST', headers: { 'content-type': tr.contentType }, body: tr.body });
j = await r.json();
console.log(`transcriptions: HTTP ${r.status} in ${Date.now() - t0}ms (includes whisper load)`);
if (r.ok) {
  console.log(`  language: ${j.language} | duration: ${j.duration}s | words: ${j.words?.length ?? 0}`);
  console.log('  text:', j.text.slice(0, 100));
} else {
  console.log('  error:', JSON.stringify(j).slice(0, 300));
}
