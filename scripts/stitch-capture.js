/**
 * Chunk capture + stitch replay harness.
 *
 * capture: run the REAL ElevenLabs generation once (chunked, batch mode),
 *          save every raw chunk PCM + the exact text each call received to
 *          an output dir. One quota spend, full fidelity.
 * replay:  re-run ONLY the join stage (aligned trim → fade → concat) from the
 *          saved chunks. Zero generation, zero quota — iterate on stitching
 *          performance/quality as often as needed.
 *
 * Usage:
 *   node scripts/stitch-capture.js capture <textfile> <outdir> [voice] [model]
 *   node scripts/stitch-capture.js replay   <outdir>
 *
 * Example:
 *   node scripts/stitch-capture.js capture text.txt logs/stitch-capture tLz0KTPteAXd06XSE8k3 eleven_v3
 *   node scripts/stitch-capture.js replay   logs/stitch-capture
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── minimal .env loader (ELEVENLABS_API_KEY for the real adapter) ─────────
function loadEnv() {
  const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function pcmToWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const mode = process.argv[2];

// ═══════════════════════════════════════════════════════════════════════════
//  ONE — manual single-chunk generation (the gated spend mode).
//  Same planner as the automated pipeline (buildChunkRequests — imported
//  from chunking.js itself), so a captured chunk is byte-identical to what
//  the automated path would send. One API call, write-through manifest.
//
//  node scripts/stitch-capture.js one <textfile> <outdir> <N> [--dry] [voice] [model]
//  N is 1-based. --dry prints the plan + exact request text, never calls the API.
// ═══════════════════════════════════════════════════════════════════════════
if (mode === 'one') {
  const dry = process.argv.includes('--dry');
  const spend = process.argv.includes('--i-know-this-spends');
  const withOverlap = process.argv.includes('--with-overlap');
  const rawArgs = process.argv.slice(3).filter(a => !a.startsWith('--'));
  const [textFile, outDirArg, nArg, voiceArg, modelArg] = rawArgs;
  const n = parseInt(nArg, 10);
  if (!textFile || !outDirArg || !Number.isInteger(n) || n < 1) {
    console.error('usage: one <textfile> <outdir> <N> [--dry] [--i-know-this-spends] [--with-overlap] [voice] [model]');
    process.exit(1);
  }
  const outDir = resolve(ROOT, outDirArg);
  mkdirSync(outDir, { recursive: true });

  const { buildChunkRequests } = await import(pathToFileURL(resolve(ROOT, 'server/chunking.js')).href);
  const text = readFileSync(resolve(ROOT, textFile), 'utf8');
  const voice = voiceArg ?? 'tLz0KTPteAXd06XSE8k3';
  const model = modelArg ?? 'eleven_v3';

  // Same limit the pipeline derives for eleven_v3
  const requests = buildChunkRequests(text, 4800);
  if (n > requests.length) {
    console.error(`requested chunk ${n} but plan has ${requests.length}`);
    process.exit(1);
  }
  const req = requests[n - 1];
  if (withOverlap && req.overlapText === '') {
    // Manual override: chunk 1 normally has no overlap. For A/B testing we
    // prepend the LAST paragraph of the source text so v3 sees warmup context
    // — same trick the pipeline uses for chunks 2+.
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const lastPara = paragraphs[paragraphs.length - 1];
    req.overlapText = lastPara;
    req.text = lastPara + '\n\n' + req.text;
    req.chunkExtra = { ...req.chunkExtra, previous_text: lastPara };
    console.log(`[with-overlap] forced overlap on chunk ${n}: prepended ${lastPara.length} chars`);
  }

  console.log(`PLAN — ${text.length} chars → ${requests.length} chunks @ 4800 limit`);
  requests.forEach((r, i) => {
    const mark = i === n - 1 ? ' ← THIS' : '';
    console.log(`  [${i + 1}] call=${r.text.length} chars (content ${r.text.length - r.overlapText.length} + overlap ${r.overlapText.length})${r.isFirst ? ' [first]' : ''}${r.isLast ? ' [last]' : ''}${mark}`);
  });
  console.log(`\nREQUEST TEXT for chunk ${n} (exactly what the engine receives):`);
  console.log('────────────────────────────────────────────');
  console.log(req.overlapText
    ? `[OVERLAP PREFIX] ${req.overlapText.slice(0, 200)}...\n[NEW CONTENT] ${req.text.slice(req.overlapText.length + 2, req.overlapText.length + 202)}...`
    : req.text.slice(0, 400));
  console.log('────────────────────────────────────────────');

  if (dry) {
    console.log('--dry: no API call made.');
    process.exit(0);
  }

  if (!spend) {
    console.error('\nRefusing to spend without --i-know-this-spends.');
    console.error('This call uses REAL quota. Review the dry output first, then:');
    console.error(`  node scripts/stitch-capture.js one ${textFile} ${outDirArg} ${n} --i-know-this-spends`);
    process.exit(1);
  }

  loadEnv();
  const { ElevenLabsAdapter } = await import(pathToFileURL(resolve(ROOT, 'server/cloud/elevenlabs.js')).href);
  const real = new ElevenLabsAdapter();

  console.log(`\nGENERATING chunk ${n}/${requests.length} — ${req.text.length} chars, voice ${voice}, model ${model}`);
  const t0 = Date.now();
  const stream = await real.generatePcmStream({
    text: req.text,
    voice_name: voice,
    speed: 1.0,
    instruct_text: undefined,
    extra_body: req.chunkExtra,
    model,
  });
  // Heartbeat: v3 batch renders ~2min/chunk with zero interim output —
  // print liveness so a hang is visible within 15s instead of after timeout.
  const hb = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    const got = parts.reduce((a, p) => a + p.length, 0);
    console.log(`  …generating, ${s}s elapsed${got ? `, ${(got / 48000).toFixed(1)}s audio received` : ', no bytes yet'}`);
  }, 15000);
  const parts = [];
  try {
    for await (const p of stream) parts.push(p);
  } finally {
    clearInterval(hb);
  }
  const pcm = Buffer.concat(parts);

  if (pcm.length === 0) throw new Error('empty audio returned');

  const file = `chunk-${n - 1}.pcm`;
  writeFileSync(resolve(outDir, file), pcm);
  writeFileSync(resolve(outDir, `chunk-${n - 1}.txt`), req.text);

  // merge into manifest (write-through, crash-safe)
  const manifestPath = resolve(outDir, 'manifest.json');
  let manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { voice, model, text, totalChars: text.length, calls: [] };
  if (manifest.text !== text) throw new Error('manifest text mismatch — different input file?');
  manifest.calls = manifest.calls.filter(c => c.idx !== n - 1);
  manifest.calls.push({ idx: n - 1, file, chars: req.text.length, pcmBytes: pcm.length, ms: Date.now() - t0, text: req.text });
  manifest.calls.sort((a, b) => a.idx - b.idx);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`saved: ${file} (${pcm.length} bytes = ${(pcm.length / 48000).toFixed(1)}s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`corpus now has ${manifest.calls.length}/${requests.length} chunks`);
  if (manifest.calls.length < requests.length) {
    const next = manifest.calls.length + 1;
    console.log(`\nnext (review the audio first!): node scripts/stitch-capture.js one ${textFile} ${outDirArg} ${next} --dry`);
  } else {
    console.log(`\nCORPUS COMPLETE — stitch offline: node scripts/stitch-capture.js replay ${outDirArg}`);
  }
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  CAPTURE — real generation, intercepted per chunk
// ═══════════════════════════════════════════════════════════════════════════
if (mode === 'capture') {
  const [textFile, outDirArg, voiceArg, modelArg] = process.argv.slice(3);
  if (!textFile || !outDirArg) {
    console.error('usage: capture <textfile> <outdir> [voice] [model]');
    process.exit(1);
  }
  const outDir = resolve(ROOT, outDirArg);
  mkdirSync(outDir, { recursive: true });

  loadEnv();
  const { ElevenLabsAdapter } = await import(pathToFileURL(resolve(ROOT, 'server/cloud/elevenlabs.js')).href);
  const { generateChunkedBatch } = await import(pathToFileURL(resolve(ROOT, 'server/chunking.js')).href);

  const text = readFileSync(resolve(ROOT, textFile), 'utf8');
  const voice = voiceArg ?? 'tLz0KTPteAXd06XSE8k3';
  const model = modelArg ?? 'eleven_v3';

  const real = new ElevenLabsAdapter();
  const calls = [];
  let callIdx = 0;

  const capturing = {
    maxChars: Infinity, // chunking drives limits via getMaxChars
    getMaxChars: (m) => real.getMaxChars(m),
    async generatePcmStream(opts) {
      const idx = callIdx++;
      const t0 = Date.now();
      const stream = await real.generatePcmStream(opts);
      const parts = [];
      for await (const p of stream) parts.push(p);
      const pcm = Buffer.concat(parts);
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      const file = `chunk-${idx}.pcm`;
      writeFileSync(resolve(outDir, file), pcm);
      calls.push({ idx, file, chars: opts.text.length, pcmBytes: pcm.length, ms: Date.now() - t0, text: opts.text });
      // Write-through: a mid-run crash still leaves a usable corpus
      writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify({
        voice, model, text, totalChars: text.length,
        rawInputFile: resolve(ROOT, textFile),
        calls,
        partial: callIdx < 9999 ? calls.length : undefined,
      }, null, 2));
      console.log(`  [capture] call #${idx}: ${opts.text.length} chars → ${(pcm.length / 48000).toFixed(1)}s audio in ${dur}s`);
      return Readable.from([pcm]);
    },
  };

  console.log(`CAPTURE — voice=${voice} model=${model} text=${text.length} chars → ${outDir}`);
  const tStart = Date.now();
  const stream = await generateChunkedBatch({
    text, engine: capturing, voiceName: voice, speed: 1.0,
    instructions: undefined, extraBody: { batch: true }, subModel: model,
    onProgress: (p) => {
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(0);
      const detail = [
        p.chars ? `${p.chars} chars` : '',
        p.pcmBytes ? `${(p.pcmBytes / 48000).toFixed(1)}s audio` : '',
        p.ms ? `${(p.ms / 1000).toFixed(1)}s` : '',
      ].filter(Boolean).join(', ');
      console.log(`  [progress ${elapsed}s] ${p.stage} ${p.chunk}/${p.totalChunks}${detail ? ' — ' + detail : ''}`);
    },
  });

  const parts = [];
  for await (const p of stream) parts.push(p);
  const stitched = Buffer.concat(parts);
  writeFileSync(resolve(outDir, 'stitched.pcm'), stitched);
  writeFileSync(resolve(outDir, 'stitched.wav'), pcmToWav(stitched));
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify({
    voice, model, text, totalChars: text.length,
    rawInputFile: resolve(ROOT, textFile),
    calls,
    stitchedBytes: stitched.length,
  }, null, 2));

  console.log(`\ncaptured ${calls.length} chunks (${calls.reduce((a, c) => a + c.pcmBytes, 0)} bytes raw)`);
  console.log(`stitched: ${(stitched.length / 48000).toFixed(1)}s → ${outDir}\\stitched.wav`);
  console.log(`replay anytime: node scripts/stitch-capture.js replay ${outDirArg}`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  REPLAY — join stage only, from saved chunks
// ═══════════════════════════════════════════════════════════════════════════
if (mode === 'replay') {
  const outDirArg = process.argv[3];
  if (!outDirArg) { console.error('usage: replay <outdir>'); process.exit(1); }
  const outDir = resolve(ROOT, outDirArg);
  const manifestPath = resolve(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) { console.error(`no manifest.json in ${outDir}`); process.exit(1); }

  const { generateChunkedBatch } = await import(pathToFileURL(resolve(ROOT, 'server/chunking.js')).href);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  let callIdx = 0;
  const replayEngine = {
    maxChars: Infinity,
    getMaxChars: () => 4800, // match the capture split — same chunks, same overlaps
    async generatePcmStream(opts) {
      const saved = manifest.calls[callIdx];
      if (!saved) throw new Error(`replay: no saved chunk for call #${callIdx}`);
      if (saved.chars !== opts.text.length) {
        throw new Error(`replay: chunk ${callIdx} text mismatch (saved ${saved.chars}, requested ${opts.text.length}) — manifest out of sync with current splitting logic`);
      }
      const pcm = readFileSync(resolve(outDir, saved.file));
      console.log(`  [replay] call #${callIdx}: ${saved.chars} chars → ${(pcm.length / 48000).toFixed(1)}s (saved audio)`);
      callIdx++;
      return Readable.from([pcm]);
    },
  };

  console.log(`REPLAY — ${manifest.calls.length} chunks from ${outDir}`);
  const t0 = Date.now();
  const stream = await generateChunkedBatch({
    text: manifest.text, engine: replayEngine, voiceName: manifest.voice, speed: 1.0,
    instructions: undefined, extraBody: { batch: true }, subModel: manifest.model,
    onProgress: (p) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${p.stage} ${p.chunk}/${p.totalChunks}`),
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const stitched = Buffer.concat(parts);

  writeFileSync(resolve(outDir, 'stitched-replay.wav'), pcmToWav(stitched));
  const joinMs = Date.now() - t0;
  console.log(`\njoin stage: ${joinMs}ms for ${(manifest.totalChars / 4800).toFixed(1)} chunks (${(stitched.length / 48000).toFixed(1)}s audio)`);
  console.log(`output: ${outDir}\\stitched-replay.wav`);
  process.exit(0);
}

console.error('usage: node scripts/stitch-capture.js capture|replay ...');
process.exit(1);
