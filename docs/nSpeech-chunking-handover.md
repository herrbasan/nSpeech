# Handover: Auto-Chunking for Long-Form TTS

> **From:** RAUM project (client of nSpeech)
> **Date:** 2026-08-14
> **Context:** RAUM is a publication platform that generates read-aloud audio for every blog post via nSpeech (ElevenLabs engine, Melon 3 voice, `eleven_v3` model). Posts range from 500 to 1600 words (3K–11K chars). Bilingual EN/DE.

---

## The Problem

ElevenLabs v3 (and most cloud TTS engines) have a per-request text limit. For ElevenLabs v3, requests with text exceeding ~5000 characters fail with **HTTP 503 Server Unavailable** — no error body, no retry-after header. The failure is silent and gives the client no actionable information.

This is documented in the nSpeech API reference (`Max text: 5K chars` for ElevenLabs), but **nSpeech does not currently handle it**. The burden falls on the client.

### What we hit in practice

- Short articles (<4000 chars): single request, works fine.
- Medium articles (4000–5000 chars): intermittent 503.
- Long articles (>5000 chars): consistent 503.
- The 503 is **not** a rate limit, quota issue, or streaming/batch mode issue. It is purely text length.
- Batch mode (`extra_body.batch = true`) does not help — same 503.

### Current client-side workaround

RAUM's `tools/generate-tts.ps1` script splits text on paragraph boundaries into ≤4000-char chunks, sends each chunk as a separate `/v1/audio/speech` request, and concatenates the MP3 bytes into a single file. This works but has two quality issues:

1. **Cold-start artifact**: The voice "resets" at each chunk boundary. The prosody at the start of chunk 2 sounds different from the end of chunk 1 — a brief shift in tone, pacing, or emphasis that is audible on careful listening.

2. **No silence padding**: Chunks are concatenated at the byte level. There's no breath/pause inserted between the last sentence of one chunk and the first of the next.

---

## Proposed Solution: Server-Side Auto-Chunking

Move the chunking logic into nSpeech so any client sending long text gets correct audio without knowing about engine limits.

### API surface (no breaking change)

The `/v1/audio/speech` endpoint already accepts arbitrary-length text. The change is purely internal: when text exceeds the active engine's char limit, nSpeech chunks, generates, and stitches transparently.

**New `extra_body` field for client control:**

```json
{
  "extra_body": {
    "auto_chunk": true,          // default: true (enable transparent chunking)
    "chunk_overlap": 1           // default: 1 (prepend N paragraphs from prev chunk as warmup)
  }
}
```

Clients who want the current behavior can set `auto_chunk: false`.

### Chunking strategy

1. **Split on paragraph boundaries** (double newline). Never split mid-sentence or mid-paragraph.
2. **Accumulate paragraphs into chunks** up to the engine's char limit (configurable per adapter — 4000 for ElevenLabs to leave headroom).
3. **Overlap**: For chunk N>1, prepend the last `chunk_overlap` paragraphs from chunk N-1 as "warmup context." This gives the engine running prosody so the voice doesn't reset cold.

### The stitching problem (needs timestamps)

The overlap paragraphs must be **trimmed from the final audio** — they're context, not content. To do this, nSpeech needs to know when the overlap ends and the real content begins.

**ElevenLabs provides character-level timestamps** via the `with_timestamps` parameter on the non-streaming endpoint:

```
POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000
Body: { ..., with_timestamps: true }

Response: {
  audio_base64: "...",
  alignment: {
    characters: ["H", "e", "l", "l", "o"],
    character_start_times_seconds: [0.0, 0.05, 0.1, 0.15, 0.2],
    character_end_times_seconds: [0.05, 0.1, 0.15, 0.2, 0.25]
  }
}
```

**Flow for overlap stitching:**

```
Chunk 1: [para1] [para2] [para3]                    → keep full audio
Chunk 2: [para3_overlap] [para4] [para5] [para6]    → request with_timestamps
           ^^^^^^^^^^^^^^^^^ trim everything before
           the first character of para4 using alignment data
Chunk 3: [para6_overlap] [para7] [para8]            → same trim approach
```

The trim point is the character start time of the first character of the first "real" paragraph in each chunk. Convert that time to a PCM byte offset (`time × sample_rate × bytes_per_sample`) and slice the buffer.

**Concatenation:** After trimming, concatenate PCM buffers. Optionally insert a short silence (200–400ms of zero-valued samples) between chunks for a natural breath.

### Engine-agnostic design

The cold-start problem affects all TTS engines, not just ElevenLabs. The chunking logic should live in the **engine manager / worker routes** layer, not in individual adapters.

Each adapter declares:
- `maxChars`: the engine's per-request limit (ElevenLabs: 5000, MiniMax: 10000, local: Infinity)
- `supportsTimestamps`: whether the adapter can return alignment data (ElevenLabs: yes, others: TBD)

If `supportsTimestamps` is false, fall back to simple concatenation (current behavior) — no overlap, just paragraph-boundary chunking.

### Where in the code

The speech endpoint handler in `server/engine/worker.js` (or wherever the Node-side route calls the adapter) is the right place. Before calling `adapter.generatePcmStream()`, check `text.length > adapter.maxChars`. If so, chunk and loop.

For the timestamp variant, the ElevenLabs adapter needs a new method (e.g., `generatePcmWithAlignment()`) that calls the non-streaming endpoint with `with_timestamps: true` and returns `{ pcm: Buffer, alignment: {...} }`.

---

## Summary of what RAUM needs from nSpeech

| Priority | Feature | Why |
|----------|---------|-----|
| **P0** | Auto-chunk long text transparently | So clients don't need to know about engine limits |
| **P1** | Overlap + timestamp-based trimming | Eliminates the audible "reset" at chunk boundaries |
| **P2** | Inter-chunk silence padding | Natural breath between paragraphs across boundaries |
| **P2** | `auto_chunk` and `chunk_overlap` in `extra_body` | Client control for edge cases |

Until this is implemented, RAUM will continue using its client-side chunking script (`tools/generate-tts.ps1`) with simple byte concatenation. The audio quality is good enough for publication — the chunk boundary artifacts are subtle and only noticeable on careful listening with headphones.

---

## Reference: RAUM's current client-side implementation

- Script: `tools/generate-tts.ps1` in the RAUM repo
- Splits on `\n\n` paragraph boundaries, 4000-char max per chunk
- 5-second pause between chunk requests (rate-limit courtesy)
- Byte-level MP3 concatenation (MP3 frames are independent — valid but no cross-chunk optimization)
- 15 of 16 posts generated successfully (EN+DE), 30 files, 240 MB total
- Only failure mode: ElevenLabs 503 on >5000 char single requests (solved by chunking)
