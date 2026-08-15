/**
 * Encode a fixture PCM chunk at candidate settings, report sizes.
 * Usage: node scripts/encode-bench.js [chunkN]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { config } = await import(pathToFileURL(resolve(ROOT, 'server/config.js')).href);
const ff = config.ffmpegPath;

const n = process.argv[2] ?? '3';
const input = resolve(ROOT, `logs/stitch-ghost/chunk-${n}.pcm`);
const outDir = resolve(ROOT, 'logs/stitch-ghost/enc-test');
mkdirSync(outDir, { recursive: true });

const FILTER = 'dynaudnorm=f=50:g=5:p=0.8:m=5:b=1';
const base = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', input, '-af', FILTER];

const variants = [
  ['mp3-128k.mp3',  ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_id3v1', '0', '-f', 'mp3']],
  ['mp3-64k.mp3',   ['-c:a', 'libmp3lame', '-b:a', '64k',  '-id3v2_version', '0', '-write_id3v1', '0', '-f', 'mp3']],
  ['mp3-48k.mp3',   ['-c:a', 'libmp3lame', '-b:a', '48k',  '-id3v2_version', '0', '-write_id3v1', '0', '-f', 'mp3']],
  ['opus-48k.ogg',  ['-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-f', 'ogg']],
  ['opus-32k.ogg',  ['-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-f', 'ogg']],
];

const pcmSec = statSync(input).size / 48000;
console.log(`input: chunk-${n}.pcm, ${pcmSec.toFixed(1)}s, ${(statSync(input).size / 1048576).toFixed(1)} MB raw`);

for (const [name, args] of variants) {
  const out = resolve(outDir, name);
  const r = spawnSync(ff, [...base, ...args, '-y', out], { encoding: 'utf8' });
  if (r.status !== 0) { console.log(`${name}: FAILED — ${r.stderr.slice(0, 200)}`); continue; }
  const kb = statSync(out).size / 1024;
  console.log(`${name}: ${kb.toFixed(0)} KB (${(kb * 8 / pcmSec).toFixed(0)} kbps effective)`);
}
process.exit(0);
