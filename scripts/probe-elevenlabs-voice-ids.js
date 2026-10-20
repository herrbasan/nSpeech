/**
 * Probe: what does ElevenLabs' voice catalogue actually contain, and what shape
 * are its voice ids?
 *
 * Two questions, both needed before request-time voice validation (#5):
 *   1. Is the adapter's `voice_type=personal` listing complete? If it omits
 *      premade voices, membership validation would reject ids that synthesise
 *      fine — so validation must not rely on it.
 *   2. Are voice ids always 20 alphanumeric chars? If so, a structural check
 *      rejects a Kokoro-style name ('Kimi') with zero false positives.
 *
 * Listing is free — no synthesis, no quota.
 * Run: node scripts/probe-elevenlabs-voice-ids.js
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter(line => line.includes('=') && !line.trimStart().startsWith('#'))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
);

const KEY = env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error('ELEVENLABS_API_KEY missing from .env');

const ID_SHAPE = /^[A-Za-z0-9]{20}$/;

async function probe(label, query) {
  const resp = await fetch(`https://api.elevenlabs.io/v2/voices?page_size=100${query}`, {
    headers: { 'xi-api-key': KEY },
  });
  const status = resp.status;
  if (!resp.ok) {
    console.log(`${label}: HTTP ${status} — ${(await resp.text()).slice(0, 160)}`);
    return null;
  }
  const data = await resp.json();
  const voices = data.voices || [];
  const categories = {};
  for (const v of voices) categories[v.category] = (categories[v.category] || 0) + 1;
  const badShape = voices.filter(v => !ID_SHAPE.test(v.voice_id));
  console.log(`${label}: HTTP ${status} · returned ${voices.length}/${data.has_more ? 'more' : 'all'}`
    + ` · categories ${JSON.stringify(categories)}`);
  if (badShape.length) {
    console.log(`  ids not matching ${ID_SHAPE}: ${badShape.slice(0, 5).map(v => `${v.voice_id} (${v.voice_id.length}, ${v.category})`).join(', ')}`
      + (badShape.length > 5 ? ` … +${badShape.length - 5}` : ''));
  }
  return { voices, categories };
}

const unfiltered = await probe('no filter      ', '');
const personal = await probe('voice_type=personal', '&voice_type=personal');
const premade = await probe('category=premade ', '&category=premade');

if (unfiltered && personal) {
  const unf = new Set(unfiltered.voices.map(v => v.voice_id));
  const per = new Set(personal.voices.map(v => v.voice_id));
  const missing = [...unf].filter(id => !per.has(id));
  console.log(`\npersonal-only omits ${missing.length} voice(s) the unfiltered listing returns`);
  console.log(`premade listing returns ${premade ? premade.voices.length : 'n/a'} voice(s)`);
  const allIds = [...unfiltered.voices, ...(premade?.voices || [])].map(v => v.voice_id);
  const nonShape = allIds.filter(id => !ID_SHAPE.test(id));
  console.log(`ids across both listings: ${allIds.length}, not 20-char alnum: ${nonShape.length}`
    + (nonShape.length ? ` (${[...new Set(nonShape)].slice(0, 5).join(', ')})` : ''));
}
