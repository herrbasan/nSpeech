const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. HF parakeet models — id + lastModified only
const hf = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'hf-parakeet.json'), 'utf8'));
console.log('=== NVIDIA parakeet models on HF (by lastModified, newest first) ===');
for (const m of hf) {
  console.log(`${m.lastModified || '?'}  ${m.id}  (downloads: ${m.downloads ?? '?'}, likes: ${m.likes ?? '?'})`);
}

// 2. sherpa-onnx releases — tag, date, and any line mentioning parakeet/timestamp
const rel = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'sherpa-releases.json'), 'utf8'));
console.log('\n=== sherpa-onnx releases (tag, date) ===');
for (const r of rel) console.log(`${r.published_at || '?'}  ${r.tag_name}`);

console.log('\n=== release-body lines mentioning parakeet / timestamp / parakeet-related ===');
for (const r of rel) {
  const body = r.body || '';
  const lines = body.split('\n').filter(l => /parakeet|timestamp/i.test(l));
  if (lines.length) {
    console.log(`--- ${r.tag_name} ---`);
    for (const l of lines.slice(0, 10)) console.log('  ' + l.trim().slice(0, 200));
  }
}
