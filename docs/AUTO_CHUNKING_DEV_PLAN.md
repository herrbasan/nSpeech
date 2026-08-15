# Dev Plan: Server-Side Auto-Chunking for Long-Form TTS

**Date:** 2026-08-14  
**Status:** Draft  
**Depends on:** `docs/nSpeech-chunking-handover.md` (RAUM requirements), `docs/providers/elevenlabs.md` (updated API reference)

---

## Problem

Cloud TTS engines have per-request text limits. ElevenLabs v3: ~5000 chars. RAUM blog posts: 3K–11K chars. Text exceeding the limit gets a silent HTTP 503 with no actionable error.

Currently the client (RAUM's `generate-tts.ps1`) handles chunking. This moves the burden server-side so any nSpeech client gets correct audio transparently.

## Design Decision: Continuity Strategy

The handover proposed overlap+timestamp-trimming (Approach C). After researching the current ElevenLabs API, we've identified a simpler path:

| Approach | Mechanism | Complexity | Risk |
|----------|-----------|------------|------|
| **A — `previous_text`** | Pass preceding chunk text as context | Low | Text-only context may not fully eliminate cold-start |
| **B — `previous_request_ids`** | Pass preceding request IDs (actual audio context) | Medium | Requires `enable_logging=true`, ID tracking across chunks |
| **C — Overlap + timestamps** | Generate overlap audio, trim via alignment data | High | Fragile char-offset mapping, non-streaming only |

**Decision:** Implement A first. The `previous_text`/`next_text` fields are available on all four ElevenLabs TTS endpoints (convert, stream, both timestamp variants). They're purpose-built for multi-request continuity. If A doesn't eliminate the cold-start artifact in listening tests, upgrade to B. Only fall back to C if both are insufficient.

This avoids the entire timestamp/trim/cut complexity from the handover — no alignment parsing, no audio slicing, no character-offset fragility.

---

## Architecture

### Where chunking lives

A new module: `server/chunking.js`. Called from `server/api/speech.js` between engine resolution and `generatePcmStream()`. Engine-agnostic — works for any adapter that declares a char limit.

```
Client POST /v1/audio/speech
  → speech.js relaySpeech()
    → manager.getEngine(model)          ← resolve engine
    → presets.lookup()                  ← resolve voice preset
    → chunking.shouldChunk(text, engine) ← NEW: check if chunking needed
    → if yes: chunking.generateChunked() ← NEW: chunk + loop + stitch
    → if no:  engine.generatePcmStream() ← existing path unchanged
    → pipePcmToClient()                 ← transcode as usual
```

### Engine capability metadata

Each adapter/worker declares its limits. Add a `maxChars` property to the engine interface:

| Engine | `maxChars` | Continuity support | Strategy |
|--------|------------|-------------------|----------|
| ElevenLabs | 4800 (safety margin from 5000 API limit) | ✅ `previous_text`, `next_text`, `previous_request_ids`, `next_request_ids` | Approach A → B |
| MiniMax | 9800 (safety margin from 10000 API limit) | ❌ No continuity fields in T2A v2 | Simple concat; async endpoint as future alternative |
| Gemini | 4800 | ❌ No continuity fields (LLM prompt-based) | Simple concat |
| xAI | 14800 (safety margin from 15000 API limit) | ❌ No continuity fields found | Simple concat; most posts fit in one request |
| Local (Kokoro, Chatterbox, etc.) | `Infinity` | N/A — no char limit | No chunking needed |

**Provider research findings (2026-08-14):**

- **ElevenLabs** is the only provider with native continuity fields. `previous_text`/`next_text`/`previous_request_ids`/`next_request_ids` are available on all four TTS endpoints. Primary chunking target.
- **MiniMax** has no continuity fields in the sync T2A v2 API. However: (1) the async endpoint `/v1/t2a_async_v2` accepts up to **1M chars** in a single request — sidesteps chunking entirely, different architecture (async job + polling); (2) `subtitle_enable` + `subtitle_type: "sentence"/"word"` returns timestamped subtitle data — could support overlap+trim if ever needed.
- **Gemini** is LLM-based TTS. No continuity fields. Preceding text could theoretically go into the prompt as context, but untested and unpredictable. Simple concatenation only.
- **xAI** has no continuity fields. 15K char limit is the most generous — most blog posts fit in one request. Has `with_timestamps` with per-char `graph_times` (overlap+trim possible if needed). WebSocket endpoint claims no text length limit.

**Phase 4 strategy per provider:** Rather than forcing `previous_text` everywhere, use the best available strategy per provider. ElevenLabs gets continuity fields. MiniMax/Gemini/xAI get simple concatenation with optional silence padding. MiniMax async endpoint is a future optimization (would need a different code path — job submission + polling + retrieval).

For cloud adapters: add `maxChars` as a property on the adapter class.  
For local workers: `Infinity` — no chunking needed (Python engines handle arbitrary length internally).

### Chunking algorithm

```
Input: text (string), maxChars (int)

1. Split text into paragraphs on /\n\s*\n/ (double newline)
2. If any single paragraph exceeds maxChars, split it on sentence boundaries (. ! ? followed by space/newline)
3. If any single sentence exceeds maxChars, split on comma/semicolon
4. If any segment still exceeds maxChars, hard-split at maxChars (last resort)
5. Accumulate paragraphs into chunks, never exceeding maxChars
6. Return: array of { text, isFirst, isLast }
```

### Two-mode chunking strategy

**Streaming mode (client wants progressive audio):** Simple chunks, no overlap, no alignment. Generate chunk 1 → stream → generate chunk 2 → stream. The client hears the seam (masked by silence padding) but gets progressive audio. Minimal latency impact.

**Batch mode (client wants a file):** High-quality stitching. Overlap + nVoice alignment + precise trim + fade + silence. The client waits longer but gets seamless audio. This is what RAUM needs for blog post files.

The mode is determined by `extra_body.batch` (client's choice). Batch=true → high-quality stitching. Batch=false → simple streaming chunks.

### Streaming chunks (simple)

Current implementation: `splitIntoChunks` → sequential `generatePcmStream` → concatenate PCM → transcode. No overlap, no alignment. Works for all engines.

### Batch stitching (high-quality)

For batch mode, use overlap + nVoice alignment to eliminate the cold-start artifact:

1. **Overlap:** Prepend the last paragraph of chunk N to chunk N+1 as "warmup context." The engine generates this overlap audio but we discard it.
2. **Generate:** Chunk N+1 = overlap + real content. Use regular TTS endpoint (no timestamps needed from the provider).
3. **Align:** Send chunk audio + full chunk text to nVoice `/v1/audio/align`. Get word-level timestamps.
4. **Trim:** Find the first word after the overlap text. Trim PCM at that word's start time. Apply 10-20ms fade to smooth the cut.
5. **Pad:** Insert 300ms silence between chunks.
6. **Concatenate:** Append trimmed chunk to previous chunks.

**Why nVoice alignment:** Engine-agnostic (works on v3, v2, flash, MiniMax, xAI, local), no provider API dependency, word-level precision is sufficient, already integrated into nSpeech.

**Cost:** ~2-5 seconds per chunk for alignment. Acceptable for batch file generation.

### Continuity injection (v2 models only)

For ElevenLabs v2 models that support `previous_text`/`next_text`:
- Chunk N>1: `previous_text` = full text of chunk N-1
- Chunk N (not last): `next_text` = full text of chunk N+1

For v3 and other providers: no continuity fields (v3 rejects them, others don't have them). The nVoice alignment approach replaces continuity fields entirely.

### PCM stitching

Simple concatenation. The chunking module generates each chunk sequentially (await each `generatePcmStream`), collects all PCM into a single buffer, and returns it as a Readable.

Optional inter-chunk silence: insert N ms of zero-valued s16le samples between chunks. Default: 300ms. Configurable via `extra_body.chunk_silence_ms`.

### Streaming vs batch

**Phase 1 (current):** Simple streaming chunks for all modes. No overlap, no alignment.

**Phase 2 (this plan):** High-quality batch stitching. When `extra_body.batch = true`, use overlap + nVoice alignment.

**Future:** True streaming with overlap — stream chunk 1, then while chunk 1 is still flowing, start generating chunk 2 with overlap, align on the fly, trim, and seamlessly continue the stream. Complex; defer until there's a real streaming consumer.

---

## Implementation Plan

### Phase 1: Core chunking (P0 + P1)

#### Step 1: Engine capability metadata

**Files:** `server/cloud/elevenlabs.js`, `server/cloud/minimax.js`, `server/cloud/gemini.js`, `server/cloud/xai.js`, `server/engine/worker.js`

Add `maxChars` property to each cloud adapter class:
```javascript
class ElevenLabsAdapter {
  get maxChars() { return 4800; }  // 5000 API limit minus safety margin
  // ...
}
```

For `WorkerProcess` (local engines): `get maxChars() { return Infinity; }`

#### Step 2: Chunking module

**New file:** `server/chunking.js`

Exports:
- `shouldChunk(text, engine)` → boolean: `text.length > engine.maxChars`
- `splitIntoChunks(text, maxChars)` → `[{ text, isFirst, isLast }]`
- `generateChunked({ text, engine, voiceName, speed, instructions, extraBody, subModel })` → Readable (PCM stream)

`generateChunked` flow:
1. `splitIntoChunks(text, engine.maxChars)`
2. For each chunk:
   - Build `extra_body` with `previous_text` / `next_text` (continuity)
   - Call `engine.generatePcmStream({ text: chunk.text, ... })` with batch mode
   - Collect PCM buffer
   - Optionally append silence samples
3. Concatenate all PCM buffers
4. Return `Readable.from([combinedBuffer])`

#### Step 3: ElevenLabs adapter — continuity field support

**File:** `server/cloud/elevenlabs.js`

Modify `generatePcmStream()` to read `extra_body.previous_text` and `extra_body.next_text` and inject them into the ElevenLabs request body:

```javascript
if (extra_body?.previous_text) reqBody.previous_text = extra_body.previous_text;
if (extra_body?.next_text) reqBody.next_text = extra_body.next_text;
```

These fields are already in the ElevenLabs API — just need to pass them through.

#### Step 4: Wire chunking into speech.js

**File:** `server/api/speech.js`

In `relaySpeech()`, after preset resolution and before `generatePcmStream()`:

```javascript
// ── Auto-chunking for long text ─────────────────────────────────────────
if (chunking.shouldChunk(body.input, engine)) {
  pcmStream = await chunking.generateChunked({
    text: body.input,
    engine,
    voiceName,
    speed,
    instructions,
    extraBody,
    subModel,
  });
} else {
  pcmStream = await engine.generatePcmStream({ ... });  // existing path
}
```

The rest of `relaySpeech()` (transcoding, response headers) stays unchanged — `pcmStream` is still a Readable of PCM bytes either way.

#### Step 5: Client control via extra_body

**File:** `server/chunking.js` / `server/api/speech.js`

Respect `extra_body.auto_chunk` (default: `true`). When `false`, skip chunking entirely — pass text through to the engine as-is (current behavior, will 503 on ElevenLabs if too long).

Also support `extra_body.chunk_silence_ms` (default: 300) for inter-chunk silence padding.

### Phase 2: Quality verification

#### Step 6: A/B listening test

Generate the same long text (RAUM blog post, ~8000 chars) three ways:
1. **Baseline:** RAUM's client-side chunking (current production)
2. **Chunking without continuity:** server-side chunk, no `previous_text`
3. **Chunking with continuity:** server-side chunk, `previous_text` enabled

Compare chunk-boundary artifacts. If approach A (`previous_text`) eliminates the cold-start, we're done. If not, proceed to Phase 3.

### Phase 3: Upgrade continuity (conditional)

Only if Phase 2 shows `previous_text` is insufficient.

#### Step 7: `previous_request_ids` support

**File:** `server/cloud/elevenlabs.js`

- Capture `request-id` response header from each chunk generation
- Pass up to 3 prior IDs as `previous_request_ids` on subsequent chunks
- Requires `enable_logging=true` (default) — request stitching must be available

### Phase 4: Other providers (research complete — 2026-08-14)

Research done. Findings:

| Provider | Continuity fields | Long-form alternative | Phase 4 action |
|----------|------------------|----------------------|----------------|
| MiniMax | ❌ None in T2A v2 | ✅ `/v1/t2a_async_v2` (1M chars, async job) | Simple concat now; async endpoint as future optimization |
| Gemini | ❌ None (LLM prompt-based) | ❌ None | Simple concat only |
| xAI | ❌ None found | WS endpoint claims no limit | Simple concat; 15K limit covers most posts |

**Action:** All three providers get `maxChars` + simple concatenation chunking (P0). No continuity injection — adapters ignore the `previous_text`/`next_text` fields. The cold-start artifact remains on these providers but is masked by inter-chunk silence.

**Future optimization (MiniMax):** The async endpoint (`/v1/t2a_async_v2`) accepts up to 1M chars in one request. This would eliminate chunking for MiniMax entirely, but requires a different code path: job submission → poll `/v1/query/t2a_async_query_v2` → retrieve audio from `/v1/files/retrieve_content`. Defer until there's a MiniMax long-form consumer.

**Future optimization (xAI):** The WebSocket endpoint (`wss://api.x.ai/v1/tts`) has no text length limit. Could stream unlimited text in one session. Defer — requires WS client implementation in the adapter.

---

## API Changes

### New `extra_body` fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto_chunk` | boolean | `true` | Enable/disable transparent chunking |
| `chunk_silence_ms` | int | `300` | Inter-chunk silence in milliseconds (0 = none) |

No breaking changes. Clients who don't send these fields get the default behavior (auto-chunking on, 300ms silence).

### Response headers

When chunking is active, add:
- `X-Chunked: true`
- `X-Chunk-Count: <N>` (number of chunks generated)

This lets clients know the response was chunked (for debugging/quality assessment).

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `server/chunking.js` | **Create** | Chunking algorithm, PCM stitching, continuity injection |
| `server/api/speech.js` | Modify | Wire chunking into `relaySpeech()` |
| `server/cloud/elevenlabs.js` | Modify | Add `maxChars`, pass through `previous_text`/`next_text` |
| `server/cloud/minimax.js` | Modify | Add `maxChars` |
| `server/cloud/gemini.js` | Modify | Add `maxChars` |
| `server/cloud/xai.js` | Modify | Add `maxChars` |
| `server/engine/worker.js` | Modify | Add `maxChars: Infinity` to WorkerProcess |
| `documentation/API_REFERENCE.md` | Update | Document `auto_chunk`, `chunk_silence_ms` fields |
| `documentation/nSpeech_Spec.md` | Update | Document chunking architecture |

---

## Testing Strategy

1. **Unit test `splitIntoChunks`:** Various text shapes — paragraphs, single long paragraph, single long sentence, no punctuation, mixed languages (EN/DE)
2. **Integration test:** Send 8000-char text to ElevenLabs via nSpeech, verify single audio response, no 503
3. **Boundary test:** Text at exactly `maxChars`, `maxChars - 1`, `maxChars + 1`
4. **Listening test:** Compare chunk-boundary quality with and without `previous_text`
5. **Backward compat:** Short text (< maxChars) must pass through unchanged — no chunking overhead

---

## Open Questions

- [x] ~~**MiniMax/Gemini/xAI continuity:**~~ **Answered 2026-08-14.** ElevenLabs is the only provider with native continuity fields. MiniMax/Gemini/xAI get simple concatenation. See Phase 4 findings.
- [ ] **Char limit discovery:** Should we query `GET /v1/models` at startup to get the authoritative ElevenLabs char limit, or hardcode 4800? Querying is more robust but adds a startup dependency.
- [ ] **Streaming chunking:** Is there a real use case beyond RAUM? If not, batch-only is sufficient for now.
- [ ] **MiniMax async endpoint:** Worth implementing as a long-form alternative to chunking? Requires job submission + polling + retrieval code path. Defer until there's a MiniMax long-form consumer.
