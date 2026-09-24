// Check nSpeech engine model repos on Hugging Face for updates / newer siblings.
// Node 24: global fetch available. Run: node _scratch/check-models-updates.cjs
const HF = 'https://huggingface.co/api';

// (a) exact repos the project pins
const pinned = [
  'hexgrad/Kokoro-82M',
  'SWivid/F5-TTS',
  'aihpi/F5-TTS-German',
  'resemble-ai/chatterbox',            // Chatterbox Turbo lives here (turbo subfolder)
  'microsoft/VibeVoice-1.5B',
  'Systran/faster-whisper-large-v3',   // STT transcription (int8 quant done locally)
  'deepdml/faster-whisper-large-v3-turbo-ct2', // known faster variant, for comparison
];

// (b) sibling searches — catch NEWER model lines we don't know about
const searches = [
  ['hexgrad', 'kokoro'],
  ['SWivid', 'F5-TTS'],
  ['resemble-ai', 'chatterbox'],
  ['microsoft', 'vibevoice'],
  ['Systran', 'whisper-large'],
];

const fmt = (d) => (d || '?').slice(0, 10);

async function j(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'nspeech-update-check' } });
  if (!r.ok) return { _err: r.status };
  return r.json();
}

(async () => {
  console.log('=== Pinned repos (lastModified, downloads) ===');
  for (const id of pinned) {
    const m = await j(`${HF}/models/${id}`);
    if (m._err) { console.log(`${id}  -> HTTP ${m._err}`); continue; }
    console.log(`${fmt(m.lastModified)}  dl=${String(m.downloads).padStart(7)}  ${m.id}`);
  }

  console.log('\n=== Sibling searches (newest first, top 8) ===');
  for (const [author, q] of searches) {
    const list = await j(`${HF}/models?author=${author}&search=${q}&sort=lastModified&direction=-1&limit=8`);
    if (list._err) { console.log(`${author}/${q} -> HTTP ${list._err}`); continue; }
    console.log(`--- author=${author} search="${q}" ---`);
    for (const m of list) console.log(`${fmt(m.lastModified)}  dl=${String(m.downloads).padStart(7)}  ${m.id}`);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
