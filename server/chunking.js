/**
 * Auto-chunking for long-form TTS.
 *
 * Cloud engines have per-request text limits (ElevenLabs ~5000, MiniMax 10000,
 * xAI 15000). When client text exceeds the engine's maxChars, this module
 * splits it on natural boundaries, generates each chunk sequentially, and
 * stitches the PCM into one continuous stream. The client never sees the
 * chunking — one request in, one audio response out.
 *
 * Continuity: the chunking module injects previous_text/next_text into each
 * chunk's extra_body. Adapters that support these fields (ElevenLabs) use
 * them for prosody continuity across chunk boundaries; others ignore them.
 *
 * PCM contract: s16le 24kHz mono — same as every engine. Silence padding is
 * zero-valued samples at 24000 Hz × 2 bytes.
 */
import { Readable } from 'node:stream';
import { logger } from './logger.js';
import { emit } from './events.js';
import { alignPcm } from './stt.js';

const log = logger.child('chunking');

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_SILENCE_MS = 1000;
const DEFAULT_FADE_MS = 15; // 15ms fade at trim boundary
const DEFAULT_TAIL_FADE_MS = 75; // fade-out at chunk tail — engines may cut mid-phoneme
const DEFAULT_OVERLAP_PARAGRAPHS = 1; // prepend N paragraphs from prev chunk

/**
 * Whether the text exceeds the engine's per-request limit and needs chunking.
 * @param {string} text
 * @param {object} engine — adapter or WorkerProcess with maxChars
 * @returns {boolean}
 */
export function shouldChunk(text, engine) {
  const max = engine.maxChars ?? Infinity;
  return typeof text === 'string' && text.length > max;
}

/**
 * Split text into chunks of at most maxChars, on natural boundaries.
 *
 * Boundary hierarchy: paragraph (\n\n) → sentence (. ! ? … followed by
 * whitespace) → comma/semicolon → hard cut. Each level only applies when the
 * previous one can't produce segments under the limit.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {{text: string, isFirst: boolean, isLast: boolean}[]}
 */
export function splitIntoChunks(text, maxChars) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`splitIntoChunks: text must be a non-empty string, got ${typeof text}`);
  }
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new Error(`splitIntoChunks: maxChars must be a finite number >= 1, got ${maxChars}`);
  }

  // ── Level 1: paragraphs ─────────────────────────────────────────────────
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  // Any paragraph over the limit needs deeper splitting
  const segments = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      segments.push(para);
    } else {
      segments.push(...splitSentences(para, maxChars));
    }
  }

  // ── Accumulate segments into chunks ─────────────────────────────────────
  // Join with double newline to preserve paragraph structure for the engine.
  const chunks = [];
  let current = '';
  for (const seg of segments) {
    const candidate = current ? current + '\n\n' + seg : seg;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = seg;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((text, i) => ({
    text,
    isFirst: i === 0,
    isLast: i === chunks.length - 1,
  }));
}

/**
 * Split an oversized paragraph on sentence boundaries, then commas if needed.
 * @private
 */
function splitSentences(para, maxChars) {
  // Sentence boundary: . ! ? … followed by whitespace or end
  const sentences = para.split(/(?<=[.!?…])\s+/).filter(Boolean);

  const parts = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      parts.push(sentence);
    } else {
      parts.push(...splitCommas(sentence, maxChars));
    }
  }

  // Re-accumulate sentences into maxChars-sized groups (single newline —
  // same paragraph, just split for the limit).
  const out = [];
  let current = '';
  for (const part of parts) {
    const candidate = current ? current + ' ' + part : part;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split an oversized sentence on commas/semicolons, then hard-cut.
 * @private
 */
function splitCommas(sentence, maxChars) {
  const clauses = sentence.split(/(?<=[,;])\s+/).filter(Boolean);

  const out = [];
  let current = '';
  for (const clause of clauses) {
    const candidate = current ? current + ' ' + clause : clause;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) out.push(current);
      current = clause;
    }
  }
  if (current) out.push(current);

  // Hard-cut any remaining oversized clause (no punctuation at all)
  const final = [];
  for (const part of out) {
    if (part.length <= maxChars) {
      final.push(part);
    } else {
      for (let i = 0; i < part.length; i += maxChars) {
        final.push(part.slice(i, i + maxChars));
      }
    }
  }
  return final;
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find the byte offset in PCM audio where the real content starts (after overlap).
 *
 * Two-plan strategy:
 *   Plan A (prefix align): the boundary word sits just past the overlap — near
 *   the START of the audio. Aligning only an estimated prefix cuts MMS cost
 *   from O(chunk length) to O(overlap region), i.e. minutes → seconds on long
 *   chunks. Prefix = speech-rate estimate (words/2.6 per s × 1.6 safety) + 8s,
 *   text = overlap words + 25 following words. Word-count guarantee is
 *   unaffected (overlap still comes first, boundary index unchanged).
 *   Sanity gates: alignment word count must match; boundary must land ≥2s
 *   before the prefix end (else the estimate was too tight).
 *   On any gate failure → Plan B.
 *
 *   Plan B (full align): original behavior — align the whole chunk against
 *   the whole text. Always correct, O(chunk length).
 *
 * @param {Buffer} pcm — chunk audio (includes overlap + real content)
 * @param {string} chunkText — full text of the chunk (overlap + real content)
 * @param {string} overlapText — the overlap prefix text
 * @returns {Promise<number>} — byte offset where real content starts
 */
async function findTrimOffset(pcm, chunkText, overlapText) {
  if (!overlapText || overlapText.trim().length === 0) return 0;

  // Count words in overlap text. Words are split on whitespace.
  const overlapWords = overlapText.trim().split(/\s+/).filter(Boolean);
  const overlapWordCount = overlapWords.length;
  if (overlapWordCount === 0) return 0;

  const totalSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);

  // ── Plan A: prefix align ────────────────────────────────────────────────
  // Estimate: 2.6 words/s speech rate × 1.3 safety + 4s padding. Measured on
  // the Ghost fixture: boundaries land well inside (38.7s boundary vs 47.5s
  // estimate). Plan B (full align) catches the rare too-tight estimate.
  const prefixSec = Math.min(totalSec, (overlapWordCount / 2.6) * 1.3 + 4);
  if (prefixSec < totalSec) {
    const prefixBytes = Math.round(prefixSec * SAMPLE_RATE) * BYTES_PER_SAMPLE;
    // Text prefix: overlap + 25 following words — the boundary must be inside.
    const chunkWords = chunkText.trim().split(/\s+/);
    const prefixText = chunkWords.slice(0, overlapWordCount + 25).join(' ');

    try {
      const alignment = await alignPcm(pcm.subarray(0, prefixBytes), prefixText);
      if (alignment.words.length !== overlapWordCount + 25) {
        throw new Error(`prefix alignment word count ${alignment.words.length} != ${overlapWordCount + 25}`);
      }
      const boundaryWord = alignment.words[overlapWordCount];
      if (boundaryWord.start > prefixSec - 2) {
        throw new Error(`boundary (${boundaryWord.start.toFixed(1)}s) too close to prefix end (${prefixSec.toFixed(1)}s) — estimate too tight`);
      }
      const rawOffset = Math.round(boundaryWord.start * SAMPLE_RATE) * BYTES_PER_SAMPLE;
      const byteOffset = snapToZeroCrossing(pcm, rawOffset);
      log.info('trim boundary found (prefix)', {
        overlapWordCount,
        boundaryWord: boundaryWord.word,
        startTimeSec: boundaryWord.start.toFixed(3),
        byteOffset,
        zeroCrossingSnapBytes: byteOffset - rawOffset,
        prefixSec: prefixSec.toFixed(1),
        fullSec: totalSec.toFixed(1),
      });
      return byteOffset;
    } catch (err) {
      log.warn('prefix align failed, falling back to full align', { error: err.message });
    }
  }

  // ── Plan B: full-length align ───────────────────────────────────────────
  const alignment = await alignPcm(pcm, chunkText);

  if (alignment.words.length <= overlapWordCount) {
    throw new Error(`Alignment returned ${alignment.words.length} words but overlap has ${overlapWordCount} words — overlap extends past audio end`);
  }

  // The first word after the overlap is at index overlapWordCount
  const boundaryWord = alignment.words[overlapWordCount];
  const startTimeSec = boundaryWord.start;

  // Convert to byte offset — MUST be sample-aligned (even for s16le).
  // An odd byte offset shifts every sample by a half-sample and corrupts
  // the entire remainder of the stream.
  const rawOffset = Math.round(startTimeSec * SAMPLE_RATE) * BYTES_PER_SAMPLE;
  const byteOffset = snapToZeroCrossing(pcm, rawOffset);

  log.info('trim boundary found', {
    overlapWordCount,
    boundaryWord: boundaryWord.word,
    startTimeSec: startTimeSec.toFixed(3),
    byteOffset,
    zeroCrossingSnapBytes: byteOffset - rawOffset,
    totalPcmBytes: pcm.length,
  });

  return byteOffset;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Alignment — delegated to the local STT worker (./stt.js)
// ═══════════════════════════════════════════════════════════════════════════
// alignPcm is imported from ./stt.js — the local MMS CTC worker (true forced
// alignment: the Viterbi path is constrained to the text, word count is
// guaranteed to equal text.split().length). Historical note: this used to
// proxy to nVoice, which (a) crashed nVoice's ffmpeg with headerless PCM,
// and (b) coupled stitching to nVoice's engine lifecycle. The local worker
// is CPU-only, gpu:false — untouchable by engine switching in any service.

/**
 * Apply a short fade to the start of a PCM buffer to smooth the cut.
 * Linear fade-in over fadeMs milliseconds.
 *
 * @param {Buffer} pcm — audio to fade
 * @param {number} fadeMs — fade duration in milliseconds
 * @returns {Buffer} — faded audio
 */
function applyFadeIn(pcm, fadeMs) {
  if (fadeMs <= 0 || pcm.length === 0) return pcm;

  const fadeSamples = Math.floor(fadeMs * SAMPLE_RATE / 1000);
  const fadeBytes = fadeSamples * BYTES_PER_SAMPLE;
  const fadeLen = Math.min(fadeBytes, pcm.length);

  const faded = Buffer.alloc(pcm.length);
  pcm.copy(faded);

  for (let i = 0; i < fadeLen; i += BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(i);
    const gain = i / fadeLen; // 0.0 → 1.0 linear
    faded.writeInt16LE(Math.round(sample * gain), i);
  }

  return faded;
}

/**
 * Apply a fade-out to the end of a PCM buffer. ElevenLabs (and possibly other
 * engines) cut the audio exactly at the text end — mid-phoneme, no decay tail
 * (measured: 26% peak in the final 10ms of a chunk). Concatenating silence
 * after such a cliff produces an audible pop. A 75ms linear fade-out turns
 * the cliff into a fast decay. Applied to every chunk, last one included —
 * a clean ending is desirable there too.
 *
 * @param {Buffer} pcm — audio to fade
 * @param {number} fadeMs — fade duration in milliseconds
 * @returns {Buffer} — faded audio
 */
function applyFadeOut(pcm, fadeMs) {
  if (fadeMs <= 0 || pcm.length === 0) return pcm;

  const fadeSamples = Math.floor(fadeMs * SAMPLE_RATE / 1000);
  const fadeBytes = fadeSamples * BYTES_PER_SAMPLE;
  const fadeLen = Math.min(fadeBytes, pcm.length);

  const faded = Buffer.alloc(pcm.length);
  pcm.copy(faded);

  for (let i = 0; i < fadeLen; i += BYTES_PER_SAMPLE) {
    const pos = pcm.length - fadeLen + i;
    const sample = pcm.readInt16LE(pos);
    const gain = 1 - (i / fadeLen); // 1.0 → 0.0 linear
    faded.writeInt16LE(Math.round(sample * gain), pos);
  }

  return faded;
}

/**
 * Snap a trim offset to the nearest zero crossing, scanning forward from the
 * aligned boundary. A cut at a non-zero sample produces an audible click;
 * cutting where the waveform crosses zero makes the join physically seamless.
 * Search window: up to 25ms (600 samples) — beyond that we'd rather keep the
 * alignment offset and let the fade handle it.
 *
 * @param {Buffer} pcm — chunk audio
 * @param {number} byteOffset — aligned trim offset (sample-aligned, even)
 * @returns {number} — zero-crossing offset, or the original if none found
 */
function snapToZeroCrossing(pcm, byteOffset) {
  const maxScan = Math.min(pcm.length - BYTES_PER_SAMPLE, byteOffset + 25 * SAMPLE_RATE / 1000 * BYTES_PER_SAMPLE);
  let prev = pcm.readInt16LE(byteOffset);
  if (prev === 0) return byteOffset;
  for (let i = byteOffset + BYTES_PER_SAMPLE; i < maxScan; i += BYTES_PER_SAMPLE) {
    const cur = pcm.readInt16LE(i);
    if ((prev < 0 && cur >= 0) || (prev > 0 && cur <= 0)) {
      // Pick the sample closest to zero amplitude
      return Math.abs(prev) <= Math.abs(cur) ? i - BYTES_PER_SAMPLE : i;
    }
    prev = cur;
  }
  return byteOffset;
}

/**
 * Build the full chunk request plan from text — the SINGLE source of truth
 * shared by the automated batch pipeline and manual one-chunk-at-a-time
 * capture. Pure function: same input → same chunk texts, same overlaps,
 * same continuity fields. No duplicate logic anywhere else.
 *
 * @param {string} text — full client text
 * @param {number} maxChars — engine char limit (model-aware)
 * @param {object} [opts]
 * @param {number} [opts.overlapParagraphs=1] — trailing paragraphs prepended to next chunk
 * @returns {{ index: number, isFirst: boolean, isLast: boolean, text: string,
 *             overlapText: string, chunkExtra: {batch: boolean, previous_text?: string, next_text?: string} }[]}
 *         `text` already includes the overlap prefix — it is EXACTLY what the
 *         engine receives per call.
 */
export function buildChunkRequests(text, maxChars, opts = {}) {
  const overlapParagraphs = opts.overlapParagraphs ?? DEFAULT_OVERLAP_PARAGRAPHS;
  const chunks = splitIntoChunks(text, maxChars);

  return chunks.map((chunk, i) => {
    const prev = chunks[i - 1];
    const next = chunks[i + 1];

    let chunkText = chunk.text;
    let overlapText = '';
    if (prev && overlapParagraphs > 0) {
      const prevParagraphs = prev.text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      const overlapParas = prevParagraphs.slice(-overlapParagraphs);
      overlapText = overlapParas.join('\n\n');
      chunkText = overlapText + '\n\n' + chunk.text;
    }

    // Continuity context for v2 models (adapters drop these for v3)
    const chunkExtra = { batch: true };
    if (prev) chunkExtra.previous_text = prev.text;
    if (next) chunkExtra.next_text = next.text;

    return {
      index: i,
      isFirst: chunk.isFirst,
      isLast: chunk.isLast,
      text: chunkText,
      overlapText,
      chunkExtra,
    };
  });
}

/**
 * Generate speech for long text with high-quality batch stitching.
 *
 * Uses overlap + forced alignment (local STT worker) to eliminate the cold-start artifact:
 * 1. Prepend last paragraph of previous chunk as overlap (warmup context)
 * 2. Generate chunk with overlap using regular TTS
 * 3. Align chunk audio to find where real content starts
 * 4. Trim overlap audio, apply fade, insert silence
 * 5. Concatenate all trimmed chunks
 *
 * @param {object} opts
 * @param {string} opts.text — full client text
 * @param {object} opts.engine — adapter/worker with generatePcmStream + maxChars
 * @param {string} opts.voiceName
 * @param {number} opts.speed
 * @param {string|undefined} opts.instructions
 * @param {object} opts.extraBody — client extra_body
 * @param {string|undefined} opts.subModel
 * @param {(p: {stage: string, chunk: number, totalChunks: number, bytes: number, ms: number}) => void} [opts.onProgress]
 *        — optional progress sink. Stages: 'plan' | 'generating' | 'aligning' | 'trimmed' | 'done'.
 *          Called once per stage transition; cheap, synchronous, never blocks audio.
 * @returns {Promise<Readable>} — PCM stream of the stitched audio
 */
export async function generateChunkedBatch({ text, engine, voiceName, speed, instructions, extraBody, subModel, onProgress }) {
  if (!text || typeof text !== 'string') throw new Error('generateChunkedBatch: text required');
  if (!engine || typeof engine.generatePcmStream !== 'function') {
    throw new Error('generateChunkedBatch: engine with generatePcmStream required');
  }

  // Use model-aware limit if the engine supports it
  const maxChars = typeof engine.getMaxChars === 'function'
    ? engine.getMaxChars(subModel)
    : engine.maxChars;
  const silenceMs = extraBody?.chunk_silence_ms ?? DEFAULT_SILENCE_MS;
  const fadeMs = extraBody?.chunk_fade_ms ?? DEFAULT_FADE_MS;
  const tailFadeMs = extraBody?.chunk_tail_fade_ms ?? DEFAULT_TAIL_FADE_MS;
  const overlapParagraphs = extraBody?.chunk_overlap ?? DEFAULT_OVERLAP_PARAGRAPHS;

  // Single source of truth: the same planner the manual capture mode uses
  const requests = buildChunkRequests(text, maxChars, { overlapParagraphs });
  const totalChunks = requests.length;

  // ── Overall progress (model B: one bar + stage label) ──────────────────
  // Each chunk owns 1/totalChunks of the bar. During generation, bytes
  // streamed vs expected bytes (chars × self-calibrating bytes/char rate)
  // advance the chunk's share. Aligning/joining report via the stage label.
  // Seed rate from the Ghost fixture: 341.4s audio (16.4MB) for 4285 chars
  // ≈ 3827 bytes/char on eleven_v3 narration. Self-calibrates after chunk 1.
  let bytesPerChar = 3827;
  let lastTick = 0;
  const pct = (chunkIdx, frac) => Math.min(99, Math.round(((chunkIdx + frac) / totalChunks) * 100));
  const progress = (stage, chunkIdx, extra = {}) => {
    const p = { stage, chunk: chunkIdx, totalChunks, ...extra };
    if (typeof onProgress === 'function') onProgress(p);
    const percent = stage === 'done' ? 100
      : stage === 'plan' ? 0
      : stage === 'generating' ? pct(chunkIdx - 1, extra.tickFrac ?? 0)
      : pct(chunkIdx, 0); // aligning/trimmed/joining: chunk share complete
    emit('tts', `batch ${stage}${chunkIdx ? ` ${chunkIdx}/${totalChunks}` : ''}`, { ...p, percent });
  };

  const silenceBytes = silenceMs > 0
    ? Buffer.alloc(Math.floor(silenceMs * SAMPLE_RATE / 1000) * BYTES_PER_SAMPLE)
    : null;

  log.info('auto-chunking batch stitching', {
    totalChars: text.length,
    maxChars,
    chunkCount: totalChunks,
    chunkSizes: requests.map(r => r.text.length),
    silenceMs,
    fadeMs,
    overlapParagraphs,
  });

  progress('plan', 0, { totalChars: text.length });

  const pcmBuffers = [];

  try {
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const chunkText = req.text;
    const overlapText = req.overlapText;
    const chunkExtra = { ...extraBody, ...req.chunkExtra };
    const t0 = Date.now();
    progress('generating', i + 1, { chars: chunkText.length, overlapChars: overlapText.length });
    const stream = await engine.generatePcmStream({
      text: chunkText,
      voice_name: voiceName,
      speed,
      instruct_text: instructions,
      extra_body: chunkExtra,
      model: subModel,
    });

    // Consume with byte ticks: emit a progress update at most every 5s while
    // the chunk streams. tickFrac = received / expected bytes for this chunk.
    const expectedBytes = chunkText.length * bytesPerChar;
    const parts = [];
    let received = 0;
    lastTick = Date.now(); // suppress instant first-part tick; stage event already fired
    for await (const part of stream) {
      parts.push(part);
      received += part.length;
      const now = Date.now();
      if (now - lastTick >= 5000) {
        lastTick = now;
        progress('generating', i + 1, {
          tickFrac: Math.min(0.98, received / expectedBytes),
          audioSec: +(received / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(1),
        });
      }
    }
    const rawPcm = Buffer.concat(parts);
    bytesPerChar = rawPcm.length / chunkText.length; // self-calibrate for next chunk

    if (rawPcm.length === 0) {
      throw new Error(`Chunk ${i + 1}/${totalChunks} produced empty audio`);
    }

    let trimmedPcm = rawPcm;

    // Trim overlap audio via forced alignment (skip for first chunk)
    if (i > 0 && overlapText) {
      try {
        progress('aligning', i + 1, { pcmBytes: rawPcm.length });
        const trimOffset = await findTrimOffset(rawPcm, chunkText, overlapText);
        trimmedPcm = rawPcm.subarray(trimOffset);
        progress('trimmed', i + 1, { ms: Date.now() - t0 });
        log.info('overlap trimmed', {
          chunk: i + 1,
          overlapChars: overlapText.length,
          trimBytes: trimOffset,
          remainingBytes: trimmedPcm.length,
        });
      } catch (err) {
        progress('trim-estimated', i + 1, { reason: err.message.slice(0, 100) });
        log.warn('alignment failed, using simple trim', {
          chunk: i + 1,
          error: err.message,
        });
        // Fallback: estimate trim by overlap text proportion
        const ratio = overlapText.length / chunkText.length;
        const estimatedOffset = Math.floor(rawPcm.length * ratio * 0.95); // 5% safety
        trimmedPcm = rawPcm.subarray(estimatedOffset);
        log.info('overlap estimated trim', {
          chunk: i + 1,
          overlapChars: overlapText.length,
          estimatedOffset,
          remainingBytes: trimmedPcm.length,
        });
      }
    }

    // Apply fade to smooth the cut
    if (i > 0) {
      trimmedPcm = applyFadeIn(trimmedPcm, fadeMs);
    }

    // Fade the tail: engines may cut the final phoneme with zero decay,
    // and the following silence would make that cliff audible as a pop.
    trimmedPcm = applyFadeOut(trimmedPcm, tailFadeMs);

    pcmBuffers.push(trimmedPcm);
    if (!req.isLast && silenceBytes) pcmBuffers.push(silenceBytes);

    log.info('chunk generated', {
      index: i + 1,
      total: totalChunks,
      chars: chunkText.length - overlapText.length,
      overlapChars: overlapText.length,
      pcmBytes: trimmedPcm.length,
      ms: Date.now() - t0,
    });
    progress('chunk-done', i + 1, { pcmBytes: trimmedPcm.length, ms: Date.now() - t0 });
  }
  } catch (err) {
    // Emit failure so SSE watchers see the death instead of silence
    progress('failed', 0, { error: String(err.message ?? err).slice(0, 200) });
    throw err;
  }

  progress('done', totalChunks, { totalPcmBytes: pcmBuffers.reduce((a, b) => a + b.length, 0) });
  return Readable.from([Buffer.concat(pcmBuffers)]);
}

/**
 * Stream-mode chunking: sequential chunks, progressive PCM delivery.
 *
 * The counterpart to generateChunkedBatch for clients that want playback to
 * start as soon as possible. Each chunk is generated with the engine's
 * native streaming (no batch flag, no spoken overlap, no alignment). Chunk
 * PCM is forwarded as soon as the chunk finishes rendering, with a tail
 * fade + silence pad between chunks. Joins are audible — that's the
 * documented trade-off for speed.
 *
 * Progressive granularity is per chunk, not per engine packet: the tail
 * fade needs the chunk's final samples before anything after it can be
 * emitted, and emitting mid-chunk then fading later would glitch the
 * waveform. First byte ≈ one chunk's render time (typically 10–30s on
 * cloud engines) instead of the full text's render time.
 *
 * @param {object} opts
 * @param {string} opts.text — full client text
 * @param {object} opts.engine — adapter with generatePcmStream + maxChars
 * @param {string} opts.voiceName
 * @param {number} [opts.speed]
 * @param {string} [opts.instructions]
 * @param {object} [opts.extraBody] — client extra_body (chunk flags added per chunk)
 * @param {string} [opts.subModel]
 * @returns {Promise<Readable>} — s16le 24kHz mono PCM, pushed per chunk
 */
export async function generateChunkedStream({ text, engine, voiceName, speed, instructions, extraBody, subModel }) {
  if (!text || typeof text !== 'string') throw new Error('generateChunkedStream: text required');
  if (!engine || typeof engine.generatePcmStream !== 'function') {
    throw new Error('generateChunkedStream: engine with generatePcmStream required');
  }

  const maxChars = typeof engine.getMaxChars === 'function'
    ? engine.getMaxChars(subModel)
    : engine.maxChars;
  const silenceMs = extraBody?.chunk_silence_ms ?? DEFAULT_SILENCE_MS;
  const tailFadeMs = extraBody?.chunk_tail_fade_ms ?? DEFAULT_TAIL_FADE_MS;

  const requests = buildChunkRequests(text, maxChars, { overlapParagraphs: 0 });
  const totalChunks = requests.length;

  const silenceBytes = silenceMs > 0
    ? Buffer.alloc(Math.floor(silenceMs * SAMPLE_RATE / 1000) * BYTES_PER_SAMPLE)
    : null;

  log.info('auto-chunking stream', {
    totalChars: text.length,
    maxChars,
    chunkCount: totalChunks,
    chunkSizes: requests.map(r => r.text.length),
    silenceMs,
  });
  emit('tts', `stream plan ${totalChunks} chunks`, { stage: 'plan', chunk: 0, totalChunks, percent: 0 });

  const out = new Readable({ read() {} });

  (async () => {
    for (let i = 0; i < totalChunks; i++) {
      const req = requests[i];
      const t0 = Date.now();
      // No spoken overlap in stream mode — but previous_text/next_text still
      // go to adapters that use them for prosody (ElevenLabs). Strip the
      // batch flag: stream mode wants native engine streaming.
      const { batch: _drop, ...chunkExtra } = { ...extraBody, ...req.chunkExtra };

      emit('tts', `stream generating ${i + 1}/${totalChunks}`, { stage: 'generating', chunk: i + 1, totalChunks, percent: Math.round((i / totalChunks) * 100) });

      const stream = await engine.generatePcmStream({
        text: req.text,
        voice_name: voiceName,
        speed,
        instruct_text: instructions,
        extra_body: chunkExtra,
        model: subModel,
      });

      const parts = [];
      for await (const part of stream) parts.push(part);
      let pcm = Buffer.concat(parts);

      if (pcm.length === 0) {
        throw new Error(`Chunk ${i + 1}/${totalChunks} produced empty audio`);
      }

      pcm = applyFadeOut(pcm, tailFadeMs);
      out.push(pcm);
      if (!req.isLast && silenceBytes) out.push(silenceBytes);

      log.info('stream chunk generated', {
        index: i + 1, total: totalChunks,
        chars: req.text.length, pcmBytes: pcm.length, ms: Date.now() - t0,
      });
    }
    emit('tts', 'stream done', { stage: 'done', chunk: totalChunks, totalChunks, percent: 100 });
    out.push(null);
  })().catch(err => {
    emit('tts', 'stream failed', { stage: 'failed', error: String(err.message ?? err).slice(0, 200) });
    out.destroy(err);
  });

  return out;
}
