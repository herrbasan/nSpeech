# Context & References

**Documentation philosophy:** Every document in this repo except `README.md` is written for LLM consumption — optimized for LLM parsing, not human readability. `README.md` is the sole human-facing document.

Before proceeding, review the essential documentation:
- [README.md](README.md) — Human-facing project overview
- [docs/AUDIO_API_PLAN.md](docs/AUDIO_API_PLAN.md) — Canonical API contract and `extra_body` schema
- [docs/AUDIO_API_DEV_PLAN.md](docs/AUDIO_API_DEV_PLAN.md) — Implementation phases and status
- [documentation/API_REFERENCE.md](documentation/API_REFERENCE.md) — Endpoint reference with examples

## Collaborative Mode

You are a collaborative partner, not just an executor. Push back when a request doesn't make sense. Offer alternatives proactively. Disagreement is welcome; silent compliance is not.

Do not roleplay as a human. Think as an LLM — use your actual analytical capabilities.

## Core Development Maxims

- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code structure optimized for LLMs, not human conventions.
- **Vanilla:** Standard library first. Dependencies only when truly necessary.
- **Fail Fast:** No defensive coding, no mock data, no fallback defaults. Missing config throws at startup. When things break, let them crash and fix the root cause.
- **.env is NEVER committed:** The `.env` file contains API keys (MiniMax, ElevenLabs) and is in `.gitignore`. Before EVERY push, verify `git status` does NOT show `.env` as staged or tracked.

## nSpeech V3 Architecture

### Node.js Layer (server/)

- `server/engine/manager.js` — `EngineManager.getEngine(model)` checks cloud registry first, then local workers. Routes `model` strings to adapters. Local engine names (kokoro, chatterbox-turbo, etc.) resolve to workers; `nspeech` routes to the dashboard-selected engine; cloud prefixes route to cloud adapters.
- `server/engine/worker.js` — `WorkerProcess` wraps a Python child process. Provides `generatePcmStream()`, `listVoices()`, `cloneVoice()`, etc. — same surface as cloud adapters.
- `server/api/speech.js` / `server/api/voices.js` — handlers call engine methods. No HTTP relay knowledge needed.
- `server/transcode.js` — `pipePcmToClient(pcmStream, rawResponse, format)` spawns ffmpeg: PCM stdin → MP3/Opus/AAC stdout.

### Cloud Adapters (server/cloud/)

Each adapter runs as a plain JS module implementing the same contract as `WorkerProcess`. No Python, no venv, no child process. Cloud is stateless — no `getWorker()`, no GPU exclusion, no lazy start.

- `server/cloud/registry.js` — Maps model prefixes to adapters. Prefix match: `minimax` catches `minimax_speech_2_8_hd`, etc.
- `server/cloud/minimax.js` — MiniMax adapter. SSE hex→PCM decode. 3-step clone (upload→clone→activate). 332+ system voices.
- `server/cloud/elevenlabs.js` — ElevenLabs adapter. Raw binary PCM. Single-step clone.
- `server/cloud/gemini.js` — Google Gemini adapter. 80+ languages, auto-detects input language.
- `server/cloud/xai.js` — xAI adapter.

### Python Workers (src/nspeech/)

- `src/nspeech/worker_server.py` — uvicorn FastAPI worker. Port discovery via temp file.
- `src/nspeech/worker_routes.py` — Speech endpoint + voice management. Merges `extra_body` into adapter kwargs.
- `src/nspeech/engines/<name>.py` — Per-engine adapters implementing `generate()`, `list_voices()`, `clone()`, etc.
- `src/nspeech/tts.py` — Engine factory. `get_engine(name)` resolves `chatterbox-{turbo,eng,mtl}` → `chatterbox.py` adapter with a `model_type` argument. Other engines map directly to their module.

### Chatterbox Architecture

Chatterbox has three model variants, each a separate engine entry in `registry.json`:
- `chatterbox-turbo` — 350M Turbo model (paralinguistic tags, fastest)
- `chatterbox-eng` — 500M English model (exaggeration tuning)
- `chatterbox-mtl` — 500M Multilingual model (23 languages)

All three share one venv (`venv/chatterbox/env/`) but have **separate voice directories** (`venv/chatterbox-{turbo,eng,mtl}/voices/`). Voice caches use a uniform `.pt` extension — no cross-model confusion. The adapter (`src/nspeech/engines/chatterbox.py`) takes a `model_type` at construction and loads only that model. GPU exclusion ensures only one variant is resident at a time.

### CosyVoice — Known Issues (2026-07-07)

CosyVoice3 adapter (`src/nspeech/engines/cosyvoice.py`) is **partially functional**. The model produces good single-sentence quality but has unresolved multi-sentence issues:

- **Batch mode not truly batched:** The `inference_instruct2` call internally splits text and runs independent `model.tts()` sessions — the batch flag only controls downstream encoding, not model behavior. Voice character drifts between sentences.
- **Chunk-boundary pops:** Each internal `model.tts()` call starts a fresh vocoder session with non-zero-start samples. A 10ms fade (`_fade_boundary`) mitigates but doesn't eliminate the discontinuity.
- **Streaming quality:** Per-sentence prompt-swap was removed (prompt now set once), but vocoder resets between sentences cause inconsistent cadence. CosyVoice has no true cross-sentence prosodic context.
- **Root cause:** `inference_instruct2` is designed for single-utterance instructed generation, not paragraph-level voice cloning. Switching to `inference_zero_shot` (which uses cached speaker identity) was attempted but produced gibberish due to missing prompt_text conditioning.

**Recommendation:** Use CosyVoice for single-sentence zero-shot cloning only. For paragraphs, use Kokoro (stability) or Chatterbox English (quality). Revisit when CosyVoice upstream adds proper paragraph-level generation or we invest in a proper crossfade/caching approach.

### Dashboard (web/)

Built with NUI (`lib/nui_wc2/`). Engine-aware navigation in `web/js/app.js`. Per-engine pages at `web/pages/<engine>/generate.html` and `web/pages/<engine>/voices.html`. Chatterbox has three separate page directories (chatterbox-turbo, chatterbox-eng, chatterbox-mtl).

## Worker Lifecycle

- **Port discovery:** Workers spawn with `--port 0` (OS-assigned). The bound port is written to `%TEMP%/nspeech-<engine>-<pid>.port` — this temp file is authoritative. Stdout is a fallback (engine libraries spam stdout).
- **Health states:** `/health` returns `warming` until the adapter's model is loaded, then `ready`. GPU workers aren't marked ready until the model finishes loading.
- **GPU vs CPU:** All four local engines use GPU (Kokoro via ONNX CUDA). Only one GPU engine resident at a time. Switching to a different engine unloads the current one first.
- **Crash detection:** Worker exits unexpectedly → cleared from cache, 503 to client.
- **Stream stall detection:** Byte-flow watchdog — if no bytes arrive for `STREAM_TIMEOUT` (default 30s), Node aborts upstream, closes client, marks worker unhealthy. Catches GPU deadlocks that don't exit the process.
- **Request cancellation:** `AbortController` on every upstream fetch. Client disconnect → abort upstream immediately. Worker detects via FastAPI `Request.is_disconnected()`.
- **Process group kill:** Workers spawned in a process group. On SIGINT/SIGTERM, Node kills the entire group. On startup, Node sweeps for stale `nspeech.worker_server` processes and kills them.
- **In-flight tracking:** Atomic request counter per worker. Engine switch and unload blocked while counter is non-zero → returns 409.

## Transcoding

**Node owns all transcoding.** The original plan had workers encode mp3/opus via PyAV, but PyAV wheels on Windows lack libmp3lame. Instead:

1. Node requests `output_format: pcm` from the worker → raw s16le 24kHz mono.
2. `server/transcode.js` spawns ffmpeg (bundled via `lib/nvideo` submodule): PCM stdin → mp3/opus/aac stdout.
3. One shared transcode code path for every engine.

PCM variants:
- `pcm` — OpenAI-compatible: 24kHz s16le mono (default interpretation)
- `pcm_f32` — nSpeech native: 24kHz float32 mono. Internal clients (dashboard, Arena Slides) use this to skip conversion.

## API Conventions

- **Error schema:** All errors use OpenAI shape: `{"error": {"message", "type", "code", "param"}}`. Types: `invalid_request_error`, `engine_error`, `rate_limit_exceeded`, `service_unavailable`.
- **Streaming honesty:** `X-Stream-Mode: native` (real incremental, local engines) vs `X-Stream-Mode: chunked` (complete file sliced, cloud adapters or `offline: true`).
- **Engine switch:** `POST /v1/admin/engine` → SSE stream. Stages: `unload_start` → `unload_done` → `load_start` → `load_done`. Mutex-serialized; in-flight requests block switch with 409. Active in-flight requests to old engine are killed on switch — clients must handle mid-stream disconnect.
- **extra_body schema:** Frozen in `docs/AUDIO_API_PLAN.md` §3. 17 optional fields across 6 categories (Voice Character, Quality, Model Selection, Voice Blending, Text Processing, Audio Output, Effects). Key renames: `exaggeration`→`expressiveness`, `steps`→`inference_steps`.
- **Worker HTTP contract:** Workers expose engine-native endpoints (not OpenAI-compatible): `GET /health`, `GET /v1/voices`, `POST /v1/audio/speech`, `POST /v1/voices/clone` (multipart), `POST /v1/voices/preview`, `POST /v1/voices/mix`, `DELETE /v1/voices/{voice_id}`.

## Config

- `config.json` — service config: host, port, `default_engine`, `nvoice_url`, `voice_dir`, `model_dir`, `log_level`. Port overridden by `NSPEECH_PORT` in `.env`.
- `.env` — secrets: `MINIMAX_API_KEY`, `ELEVENLABS_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `NSPEECH_ENGINE` (startup default). `.env` is in `.gitignore` — NEVER committed.

## Key Conventions

- **PCM contract:** All engines output s16le 24 kHz mono. Node transcodes to final format.
- **Engine resolution:** `getEngine(model)` resolves cloud first, then local. Bare names like `minimax` work through cloud registry prefix match. Local engine names (kokoro, chatterbox-turbo, etc.) resolve to their workers. `nspeech` routes to the dashboard-selected engine.
- **NUI conventions:** Use `data-action` for declarative wiring. Use `nui-button.setLoading()`. Wait for `customElements.whenDefined('nui-button')` before binding. Never use `<nui-button>` without an inner `<button>`. Replace `nui-click` with native `click` on the inner element.

## Session Management

Use `memory_store` and `memory_recall` to persist context across sessions. You forget everything between sessions. Store discoveries, patterns, decisions, and preferences immediately. At session end, store a handover summary.

Never run long-lived commands without a timeout. Always set explicit timeouts. If a task is inherently long-running, start it as a background process and poll for status.
