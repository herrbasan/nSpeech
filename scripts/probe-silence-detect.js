/**
 * Probe: DSP silence-gap detection on chunk audio (offline).
 *
 * Finds contiguous low-energy runs ≥ 120ms — these are sentence/paragraph
 * pauses. The trim boundary must be a pause boundary near where the overlap
 * paragraph ends. Run on parts/part-1.wav.
 */
import { readFileSync } from 'node:fs';

const pcm = readFileSync('D:/DEV/nSpeech/logs/chunk-test/parts/part-1.wav').subarray(44);
const SR = 24000;
const winMs = 20;
const win = (SR * winMs / 1000) * 2; // bytes per window

const energies = [];
for (let off = 0; off + win <= pcm.length; off += win) {
  let sum = 0;
  for (let i = 0; i < win; i += 2) {
    const s = pcm.readInt16LE(off + i) / 32768;
    sum += s * s;
  }
  energies.push({ t: (off / 2) / SR, rms: Math.sqrt(sum / (win / 2)) });
}

// Silence runs
const th = 0.008;
const minDur = 0.12;
const runs = [];
let runStart = -1;
for (let i = 0; i <= energies.length; i++) {
  const quiet = i < energies.length && energies[i].rms < th;
  if (quiet && runStart === -1) runStart = energies[i].t;
  if (!quiet && runStart !== -1) {
    const end = i < energies.length ? energies[i].t : energies[energies.length - 1].t + winMs / 1000;
    if (end - runStart >= minDur) runs.push({ start: runStart, end, dur: end - runStart });
    runStart = -1;
  }
}

console.log(`audio: ${(pcm.length / 2 / SR).toFixed(1)}s, windows: ${energies.length}, silence runs >= ${minDur * 1000}ms: ${runs.length}`);
runs.forEach(r => console.log(`  ${r.start.toFixed(2)} → ${r.end.toFixed(2)}  (${Math.round(r.dur * 1000)}ms)`));
