# Handover — Cloud Provider 503s (2026-08-17)

**Status: RESOLVED. All four cloud providers fully working in all modes.**

## TL;DR

Long-text requests to cloud providers died with silent 503s. Root cause #1 (fixed): `speech.js` called `chunking.generateChunked()` — a function that **never existed** — for any request over an engine's `maxChars`. Root cause #2 (fixed): MiniMax rejected `"speed":"1"` sent as a **string** (strict float validation, error 2013). What looked like an SSE parser bug ("zero lines") was the same type rejection — the stream closed instantly. Fixed by coercing `body.speed` to Number at the `speech.js` boundary.

## What failed (the evidence)

**2026-08-16 evening** — user rendered the German "Was ist eine Lüge" article (9,970 chars) through MiniMax from the chat app:

```
21:50:43 speech request {model:"minimax", inputLen:9970, voice:"Melon_DE"}
21:50:43 markdown cleaned {before:9970, after:9853}
— nothing —
```

Three attempts (also Gemini at 22:08:41), same pattern: **zero error lines in the log, client gets HTTP 503**. The log read as if the request never failed — the client-side `nspeech-controller.js` caught a bare `503` with no context.

Simultaneously, an ElevenLabs batch render (7,326 chars, 2 chunks) succeeded through the same pipeline, so concurrency was exonerated. The ElevenLabs render completed with alignment + trim + transcode while MiniMax died next to it.

## Root cause #1 — dead function in the chunked path (FIXED, `6fb4304`)

`server/api/speech.js` decides per request whether the text needs chunking:

```js
if (mode !== 'off' && chunking.shouldChunk(inputText, engine)) {
  if (mode === 'stitch') {
    pcmStream = await chunking.generateChunkedBatch({...});
  } else {
    pcmStream = await chunking.generateChunked({...});   // ← NEVER EXISTED
  }
}
```

`chunking.js` exports `shouldChunk`, `splitIntoChunks`, `buildChunkRequests`, `generateChunkedBatch`. **No `generateChunked`.** It was presumably renamed during the 2026-08-15 API rename (`batch:true` → `mode:'stitch'`) and the else-branch was never updated.

**Trigger:** any request where `inputText.length > engine.maxChars`:
- MiniMax `speech-2.8-turbo`: maxChars **9,800** → 9,853-char text chunked → dead call
- Gemini: maxChars **4,800** → same text, same death
- ElevenLabs: maxChars 4,800, but the chat app sent `mode:'stitch'` explicitly → hit the working branch
- Short requests (<maxChars): never chunk, always worked — which is why dashboard tests and curl probes were green

**Why silent:** `sendError()` sent a proper 503 JSON to the client but logged **nothing**. Classic fail-silent — the prime directive calls this a structural blind spot.

**Fixes (both in commit `6fb4304`):**
1. The dead branch maps to `generateChunkedBatch` (the stitch pipeline — the only chunked implementation that exists). Trade-off: 'stream'-mode long requests now get stitch-quality buffered delivery instead of a hypothetical progressive mode that never existed.
2. `sendError` now logs `{message, status, type, stack}` on every failure. No more invisible 503s.

**Verified after restart:** MiniMax request now reaches `MiniMax generate` and engages the transcode layer. Root cause #1 is closed for all four cloud providers (they share `relaySpeech` → chunking).

## Root cause #2 — string-typed `speed` rejected by MiniMax (FIXED)

With the chunking fixed, two distinct MiniMax failures remained, same root cause:

1. **Batch path:** `invalid params, Mismatch type float64 with value string` — the request body had `"speed":"1"` (string, sent by the chat app client).
2. **Streaming path:** `MiniMax streaming produced zero audio bytes {lines:0}` in ~0.5s — initially suspected as an SSE parser bug, but the probe (`scripts/probe-minimax-stream.py`, sends `speed: 1.0` float) worked fine with 780 lines. The real cause: same param rejection closing the stream instantly.

**Fix:** `speech.js` coerces `body.speed` to `Number()` at the boundary, 400 on NaN. Both paths verified live after restart: long German article via stitch (2 chunks), short request via native streaming.

## All cloud providers — audited 2026-08-17

| Provider | maxChars | Chunking path | Streaming-in-chunk | State |
|---|---|---|---|---|
| ElevenLabs | 4,800 | stitch (working, proven) | native SSE | ✅ fully working |
| MiniMax | 9,800 | stitch + stream (both working) | SSE hex chunks | ✅ fully working (speed coercion) |
| Gemini | 4,800 | stitch + stream | unary response → buffered | ✅ fully working |
| xAI | 14,800 | stitch + stream | unary full buffer | ✅ fully working |

## Stream mode restored (2026-08-17)

`chunking.generateChunkedStream()` added: sequential chunks, native engine streaming per chunk (batch flag stripped), PCM pushed per chunk (75ms tail fade + 1000ms silence pad, no overlap/alignment). Progressive through the ffmpeg transcode — first audio after chunk 1 (~15-30s) instead of after the full render. `extra_body.mode: 'stream'` (default) now means real progressive delivery; `'stitch'` unchanged (buffered quality).

All four route through `relaySpeech` — the dead-function class of bug existed in exactly one place.

## Incidental fix (this session)

`worker_routes.py` preload hook crashed FastAPI startup: `info(msg, extra={...})` — the nspeech logger helper takes `(msg, meta=, category=)`, not `extra=`. Existing `extra={...}` calls in the same file are on the raw `logging.Logger` (stdlib signature), which is correct. Fixed in `6fb4304`. Symptom was: engine switch to f5tts → "health check failed, timed out" — real error only visible in `main-0.log` as `engine.f5tts.stderr` entries.

## Files touched

- `server/api/speech.js` — chunking mapping fix + sendError logging
- `src/nspeech/worker_routes.py` — preload info() signature
- `scripts/probe-minimax-stream.py` — raw MiniMax API probe (kept, reusable verifier)
- `scripts/mk-minimax-req.py` — repro request builder

## Open items for next session

1. ~~MiniMax SSE zero-lines bug~~ — RESOLVED: string-typed `speed`, fixed by boundary coercion
2. Text-cleaning toggle on the ~10 other engine dashboard pages (pattern in `web/pages/f5tts/generate.html`)
3. Plural acronym rule (`GPUs` → "G P U s")
4. `Agents.md` activity-log entry for 2026-08-16/17 (streaming, prosody, acronyms, defaults, preload, cloud fixes)
5. F5 heading-silence design (adapter-level section splitting) — parked
6. Per-engine stream stall timeout — now low priority: F5's own streaming defeats it for F5; cloud providers don't stall (they error)

## Key lessons (already in persistent memory #1481, #1482)

- `sendError` must log. Every silent-failure investigation in this codebase costs 10× what one log line would.
- The Python worker's `info()` helper ≠ stdlib `logging.Logger.info()` — different signatures (`meta/category` vs `extra`).
- MiniMax API accepts and streams 8.6K-char texts fine directly. Don't trust "provider can't handle it" — probe first.
