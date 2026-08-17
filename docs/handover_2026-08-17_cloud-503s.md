# Handover — Cloud Provider 503s (2026-08-17)

**Status: partially fixed. MiniMax still broken (Node-side SSE bug, precisely scoped).**

## TL;DR

Long-text requests to cloud providers died with silent 503s. Root cause #1 (fixed): `speech.js` called `chunking.generateChunked()` — a function that **never existed** — for any request over an engine's `maxChars`. Root cause #2 (open): MiniMax's adapter reads **zero SSE lines** from a stream that the raw API serves fine.

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

## Root cause #2 — MiniMax adapter consumes zero SSE lines (OPEN)

With the chunking fixed, the 8,657-char cleaned text went **direct** (< maxChars). Now:

```
05:48:55 MiniMax generate {model:"speech-2.8-turbo", batch:false, textLen:8657}
05:48:55 transcode spawning ffmpeg
05:48:55 MiniMax streaming produced zero audio bytes {lines:0, emptyAudioLines:0}
05:48:55 worker stream error: MiniMax streaming produced no audio
```

~0.5s from generate to zero-lines. **Provider probe** (`scripts/probe-minimax-stream.py`, same text, same voice, direct raw HTTP): **HTTP 200, 780 lines, 390 `data:` audio lines.** MiniMax is healthy; the adapter is broken.

**Scoped suspects** — `server/cloud/minimax.js` streaming branch (~lines 196-260), specifically:
- `stream_options.exclude_aggregated_audio: true` — short texts (42 chars) streamed fine with this option; maybe the turbo model changes behavior on long texts?
- The `resp.body` iteration/SSE parsing loop — Node fetch returns a `ReadableStream`; if the adapter consumes it as a Node stream (or vice versa) or splits lines wrong, long chunks could hit a code path that yields nothing
- SSE line framing (`data:` vs `data: ` — probe showed `data: {…}`)

**Debug plan for next session (zero MiniMax quota needed for the code work):**
1. Read `minimax.js` streaming branch carefully, compare to the known-good probe's framing (`data: ` prefix, `\n` line endings)
2. Write an offline test: feed a recorded SSE capture through the adapter's parser (no API calls)
3. The probe script doubles as the live verification tool — one short request to confirm the fix

**Temporary workaround for the user:** `extra_body.batch: true` on MiniMax requests bypasses the streaming branch entirely (batch path = single aggregated hex blob, different code). Long texts >9,800 get `chunkExtra.batch: true` from the stitch pipeline anyway, so batch mode should work for the exact texts that failed — untested, but worth one try.

## All cloud providers — audited 2026-08-17

| Provider | maxChars | Chunking path | Streaming-in-chunk | State |
|---|---|---|---|---|
| ElevenLabs | 4,800 | stitch (working, proven) | native SSE | ✅ fully working |
| MiniMax | 9,800 | stitch (fixed) | SSE hex chunks | ⚠️ broken: zero lines (open) |
| Gemini | 4,800 | stitch (fixed) | unary response → buffered | ✅ should work (physics: no streaming possible) |
| xAI | 14,800 | stitch (fixed) | unary full buffer | ✅ should work (no SSE exists) |

All four route through `relaySpeech` — the dead-function class of bug existed in exactly one place.

## Incidental fix (this session)

`worker_routes.py` preload hook crashed FastAPI startup: `info(msg, extra={...})` — the nspeech logger helper takes `(msg, meta=, category=)`, not `extra=`. Existing `extra={...}` calls in the same file are on the raw `logging.Logger` (stdlib signature), which is correct. Fixed in `6fb4304`. Symptom was: engine switch to f5tts → "health check failed, timed out" — real error only visible in `main-0.log` as `engine.f5tts.stderr` entries.

## Files touched

- `server/api/speech.js` — chunking mapping fix + sendError logging
- `src/nspeech/worker_routes.py` — preload info() signature
- `scripts/probe-minimax-stream.py` — raw MiniMax API probe (kept, reusable verifier)
- `scripts/mk-minimax-req.py` — repro request builder

## Open items for next session

1. **MiniMax SSE zero-lines bug** — scoped above, offline testable
2. Text-cleaning toggle on the ~10 other engine dashboard pages (pattern in `web/pages/f5tts/generate.html`)
3. Plural acronym rule (`GPUs` → "G P U s")
4. `Agents.md` activity-log entry for 2026-08-16/17 (streaming, prosody, acronyms, defaults, preload, cloud fixes)
5. F5 heading-silence design (adapter-level section splitting) — parked
6. Per-engine stream stall timeout — now low priority: F5's own streaming defeats it for F5; cloud providers don't stall (they error)

## Key lessons (already in persistent memory #1481, #1482)

- `sendError` must log. Every silent-failure investigation in this codebase costs 10× what one log line would.
- The Python worker's `info()` helper ≠ stdlib `logging.Logger.info()` — different signatures (`meta/category` vs `extra`).
- MiniMax API accepts and streams 8.6K-char texts fine directly. Don't trust "provider can't handle it" — probe first.
