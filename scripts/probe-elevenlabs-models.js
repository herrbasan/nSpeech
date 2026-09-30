// Probe ElevenLabs' own model list (the authoritative enumeration endpoint).
// Documentation rule: no model id gets added to the registry without being
// seen here first. Run: node scripts/probe-elevenlabs-models.js
import fs from 'node:fs';
import path from 'node:path';

const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
const m = /^\s*ELEVENLABS_API_KEY\s*=\s*(\S+)/m.exec(env);
if (!m) throw new Error('ELEVENLABS_API_KEY not found in .env');
const key = m[1];

const resp = await fetch('https://api.elevenlabs.io/v1/models', {
  headers: { 'xi-api-key': key },
});
if (!resp.ok) {
  console.error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  process.exit(1);
}
const models = await resp.json();
console.log(`models returned: ${models.length}\n`);
for (const mo of models) {
  const langs = Array.isArray(mo.languages) ? mo.languages.length : '?';
  const maxReq = mo.max_characters_request_free_user ?? mo.max_characters_request_subscribed_user ?? '?';
  const rates = mo.model_rates ? JSON.stringify(mo.model_rates) : '?';
  console.log([
    mo.model_id,
    mo.name,
    mo.category ?? '?',
    `langs:${langs}`,
    `maxCharsReq:${maxReq}`,
    `rates:${rates}`,
    mo.description ? `| ${String(mo.description).slice(0, 80).replace(/\s+/g, ' ')}` : '',
  ].join('  '));
}
