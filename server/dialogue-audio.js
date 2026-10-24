/**
 * PCM assembly for dialogue mode — s16le 24 kHz mono, the engine contract.
 *
 * Turns arrive from different voices, so their edges are not comparable: one
 * clone starts with 300 ms of room tone, the next with a 40 ms breath. Concatenating
 * raw output makes the inter-turn gap vary by hundreds of milliseconds and the
 * seams audible as timing wobble. Trimming each turn to its speech and inserting
 * the gap explicitly is what makes the gap a number instead of an accident.
 *
 * The silence threshold and window are the ones measured on real ElevenLabs
 * narration in `scripts/probe-silence-detect.js` (RMS < 0.008 over 20 ms
 * windows, 120 ms minimum run) — reused rather than re-invented, so "silence"
 * means the same thing to both tools.
 */

export const SAMPLE_RATE = 24000;
export const BYTES_PER_SAMPLE = 2;

const WINDOW_MS = 20;
const WINDOW_BYTES = (SAMPLE_RATE * WINDOW_MS / 1000) * BYTES_PER_SAMPLE;
const SILENCE_RMS = 0.008;
/** Silence left at a trimmed edge, so a cut never lands on a hard onset. */
const EDGE_GUARD_MS = 20;
/** Linear fade at a trimmed edge — the cut is already in silence, this kills DC steps. */
const EDGE_FADE_MS = 5;

/** Zero-filled silence of exactly `ms` (sample-aligned, never odd bytes). */
export function silence(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`silence: invalid duration ${ms}`);
  const samples = Math.round(ms * SAMPLE_RATE / 1000);
  return Buffer.alloc(samples * BYTES_PER_SAMPLE);
}

/** Duration of a PCM buffer in milliseconds. */
export function durationMs(pcm) {
  return (pcm.length / BYTES_PER_SAMPLE) / SAMPLE_RATE * 1000;
}

/** RMS per 20 ms window. */
function windowEnergies(pcm) {
  const out = [];
  for (let off = 0; off + WINDOW_BYTES <= pcm.length; off += WINDOW_BYTES) {
    let sum = 0;
    for (let i = 0; i < WINDOW_BYTES; i += 2) {
      const s = pcm.readInt16LE(off + i) / 32768;
      sum += s * s;
    }
    out.push({ offset: off, rms: Math.sqrt(sum / (WINDOW_BYTES / 2)) });
  }
  return out;
}

/**
 * Trim leading/trailing silence, keeping a short guard and fading the cut.
 *
 * @param {Buffer} pcm
 * @returns {{ pcm: Buffer, leadMs: number, tailMs: number } | null} — null when the
 *          whole buffer is silence (a caller error, not something to assemble)
 */
export function trimEdgeSilence(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) return null;

  const windows = windowEnergies(pcm);
  const speech = windows.filter((w) => w.rms >= SILENCE_RMS);
  if (speech.length === 0) return null;

  const guardBytes = Math.round(EDGE_GUARD_MS * SAMPLE_RATE / 1000) * BYTES_PER_SAMPLE;
  const first = speech[0].offset;
  const last = speech[speech.length - 1].offset + WINDOW_BYTES;

  let start = Math.max(0, first - guardBytes);
  let end = Math.min(pcm.length, last + guardBytes);

  // Sample alignment: an odd byte offset splits an s16 sample and corrupts
  // everything downstream (2026-08-14, half-sample misalignment).
  start -= start % BYTES_PER_SAMPLE;
  end -= end % BYTES_PER_SAMPLE;

  const trimmed = Buffer.from(pcm.subarray(start, end)); // copy — the fade mutates
  applyFadeIn(trimmed, EDGE_FADE_MS);
  applyFadeOut(trimmed, EDGE_FADE_MS);

  return {
    pcm: trimmed,
    leadMs: (start / BYTES_PER_SAMPLE) / SAMPLE_RATE * 1000,
    tailMs: ((pcm.length - end) / BYTES_PER_SAMPLE) / SAMPLE_RATE * 1000,
  };
}

function applyFadeIn(pcm, ms) {
  const samples = Math.min(Math.round(ms * SAMPLE_RATE / 1000), pcm.length / BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const gain = i / samples;
    const v = Math.round(pcm.readInt16LE(i * 2) * gain);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
}

function applyFadeOut(pcm, ms) {
  const samples = Math.min(Math.round(ms * SAMPLE_RATE / 1000), pcm.length / BYTES_PER_SAMPLE);
  const base = pcm.length / BYTES_PER_SAMPLE - samples;
  for (let i = 0; i < samples; i++) {
    const gain = 1 - (i / samples);
    const off = (base + i) * 2;
    const v = Math.round(pcm.readInt16LE(off) * gain);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), off);
  }
}
