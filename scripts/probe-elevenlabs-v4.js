// Probe how eleven_v4 / eleven_v4_turbo behave against the adapter's
// per-model assumptions (2026-09-30). Short texts, statuses only, audio
// discarded. Run: node scripts/probe-elevenlabs-v4.js
import fs from 'node:fs';
import path from 'node:path';

const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
const m = /^\s*ELEVENLABS_API_KEY\s*=\s*(\S+)/m.exec(env);
if (!m) throw new Error('ELEVENLABS_API_KEY not found in .env');
const key = m[1];

const VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // George — the adapter's default
const TEXT = 'Hallo Welt, dies ist ein kurzer Test.';
const STREAM = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=pcm_24000`;

async function call(label, body, url = STREAM) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.ok) {
    let bytes = 0;
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    console.log(`OK    ${label.padEnd(46)} bytes:${bytes}`);
  } else {
    const text = await resp.text();
    let detail = text.slice(0, 200).replace(/\s+/g, ' ');
    try { detail = JSON.parse(text).detail?.message ?? detail; } catch { /* keep raw */ }
    console.log(`ERR   ${label.padEnd(46)} HTTP ${resp.status}  ${detail}`);
  }
}

const settings = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.0 };

await call('v4 minimal',              { text: TEXT, model_id: 'eleven_v4', voice_settings: settings });
await call('v4 turbo minimal',        { text: TEXT, model_id: 'eleven_v4_turbo', voice_settings: settings });
await call('v4 + previous/next_text', { text: TEXT, model_id: 'eleven_v4', voice_settings: settings, previous_text: 'Vorheriger Satz.', next_text: 'Nachher.' });
await call('v4 + optimize_latency=3', { text: TEXT, model_id: 'eleven_v4', voice_settings: settings }, STREAM + '&optimize_streaming_latency=3');
await call('v4 + language_code=de',   { text: TEXT, model_id: 'eleven_v4', voice_settings: settings, language_code: 'de' });
await call('v4 speed 1.2',            { text: TEXT, model_id: 'eleven_v4', voice_settings: { ...settings, speed: 1.2 } });
await call('v4 speed 1.3',            { text: TEXT, model_id: 'eleven_v4', voice_settings: { ...settings, speed: 1.3 } });
await call('v4 speed 0.7',            { text: TEXT, model_id: 'eleven_v4', voice_settings: { ...settings, speed: 0.7 } });
await call('v4 speed 2.0',            { text: TEXT, model_id: 'eleven_v4', voice_settings: { ...settings, speed: 2.0 } });
await call('v4 speed 0.5',            { text: TEXT, model_id: 'eleven_v4', voice_settings: { ...settings, speed: 0.5 } });
await call('v3conv minimal',          { text: TEXT, model_id: 'eleven_v3_conversational', voice_settings: settings });
await call('v3conv + latency=3',      { text: TEXT, model_id: 'eleven_v3_conversational', voice_settings: settings }, STREAM + '&optimize_streaming_latency=3');
await call('v3conv + prev/next_text', { text: TEXT, model_id: 'eleven_v3_conversational', voice_settings: settings, previous_text: 'Vorheriger Satz.', next_text: 'Nachher.' });
