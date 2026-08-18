# Handover — 2026-08-18 — Unified SDK + Dashboard SDK Migration + Engine-Switch Fix

## What shipped this session

### 1. Unified single-file SDK — `lib/nspeech-client/nspeech-client.js`
Pure ESM, zero deps. Four exports:
- `NSpeechClient` — REST API (speech with `clean:true`, speechStream, voices, presets, clone/mix/delete, engine admin). Retry w/ backoff, typed errors, voice cache.
- `SpeechPlayer` — streaming playback (browser): decoupled download/playback (pause never aborts), MSE + blob fallback, seek/pause/resume, `opts.audio` external-element mode (for UI wrappers), byte collection → `getAudioUrl()`.
- `EventStream` — `/v1/admin/events` SSE with auto-reconnect; `progress` events carry chunking `stage`/`percent`/`chunk`/`totalChunks`. Accepts `baseUrl: ''` (same-origin).
- `cleanMarkdown` / `expandAcronyms` — the canonical regex cleaner (now the single source of truth).

Deleted: `nspeech-client-v2.js`, `markdown-clean.js`. Old v1 was overwritten by the new file.
`server/markdown-clean.js` now re-exports the regex layer from the SDK and keeps only the parked LLM prosody path (`cleanMarkdownLLM`) for legacy `extra_body.markdown: 'llm'`.

### 2. Dashboard fully on the SDK
- `web/js/dashboard.js` — creates `window.nspeech = { client, events, cleanMarkdown }` + `window.nspeechMountGenerate`. **nui/page scripts cannot `import`** — the shell must expose globals.
- `web/js/generate-widget.js` — shared playback widget: **nui-media-player** skinned transport (SpeechPlayer external-audio mode), generation progress bar from the SSE `tts` feed, TTFB/bytes status, download link. Pages call `nspeechMountGenerate(element, { filename, buildParams })`.
- All 12 generate pages migrated (each now only owns engine-specific controls). `web/js/audio-download.js` deleted. `web/js/app.js` uses `client.getEngine/listEngines/switchEngine`.
- Validated live: f5tts (36s render, TTFB 1.8s) + kokoro both stream/play through the widget.

### 3. Chat app (`D:\SRV\LLM-Gateway-Chat`) migrated
- Vendored SDK at `lib/tts/nspeech-client.js`; `lib/tts/nspeech-controller.js` dropped ~400 lines of MSE/state code → delegates to `SpeechPlayer` (keeps prefs, engine/voice selects, button-state chrome). Public API unchanged.
- Markdown cleanup is client-side (`clean:true`-equivalent); `extra_body.markdown` never sent. LLM prosody removed from UI (parked). Old `'llm'` prefs degrade to `'true'`.
- Checkpoint of pre-migration controller: `_scratch/nspeech-controller-pre-sdk.js`.

### 4. Engine-switch fix — two layers
- **SDK bug** (`nspeech-client.js`): `switchEngine` only consumed the SSE body when `onProgress` was passed, then called `res.json()` on an event stream → hung. Fixed: always parse SSE (`\n\n` blocks, `event:`/`data:`), resolve from `event:result`, throw `EngineError` on `event:error`, NO `_retry` (mutating op).
- **Manager hardening** (`server/engine/manager.js`): `_doSwitch` and `_unloadOtherGpuEngines` now drop dead/spawning/unhealthy workers fire-and-forget instead of `await`ing their `stop()` — a wedged respawn no longer blocks unrelated switches. Validated: f5tts→chatterbox-turbo→kokoro chain clean.

### 5. Docs updated
README, `documentation/API_REFERENCE.md`, `documentation/nSpeech_Spec.md` — SDK section rewritten (4 exports), markdown cleaning documented as client responsibility + legacy server path, `batch` marked deprecated.

## Server state
- Running: terminal `eace61a9` (`npm start`), current engine **kokoro** (persisted).
- All local workers cycle cleanly.

## Open / known issues (not blocking)
- **F5 voice "Melon" 404s at render** ("Voice not found: Melon") — pre-existing server-side data issue (missing sidecar), other voices fine.
- **STT worker**: not exercised this session.
- `_scratch/` in both repos holds pre-migration checkpoints — delete or commit as you see fit.
- Nothing is committed. `git status` in nSpeech shows: modified README/docs/app.js/manager.js/markdown-clean.js/nspeech-client.js, 12 generate pages, deleted audio-download.js + old SDK files, new dashboard.js/generate-widget.js, untracked `_scratch/`.

## Next-session pointers
- If a dashboard page breaks: check browser console for `window.nspeech`/`window.nspeechMountGenerate` undefined (dashboard.js load order) — page scripts get them as globals, not imports.
- The widget's server progress bar is driven by uncorrelated SSE `tts` events — fine single-user, will interleave under concurrent jobs (documented in SDK header).
- Chat app controller API surface kept identical, but it's now a thin wrapper — new playback features belong in the SDK's SpeechPlayer, not the controller.
