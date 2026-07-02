# Context & References

Before proceeding, review the essential documentation:
- [README.md](README.md)
- [docs/AUDIO_API_PLAN.md](docs/AUDIO_API_PLAN.md) — Canonical API contract and `extra_body` schema
- [docs/AUDIO_API_DEV_PLAN.md](docs/AUDIO_API_DEV_PLAN.md) — Implementation phases and status
- [docs/API_REFERENCE.md](docs/API_REFERENCE.md) — Endpoint reference with examples

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

- `server/engine/manager.js` — `EngineManager.getEngine(model)` checks cloud registry first, then local workers. Routes `model` strings to adapters.
- `server/engine/worker.js` — `WorkerProcess` wraps a Python child process. Provides `generatePcmStream()`, `listVoices()`, `cloneVoice()`, etc. — same surface as cloud adapters.
- `server/api/speech.js` / `server/api/voices.js` — handlers call engine methods. No HTTP relay knowledge needed.
- `server/transcode.js` — `pipePcmToClient(pcmStream, rawResponse, format)` spawns ffmpeg: PCM stdin → MP3/Opus/AAC stdout.

### Cloud Adapters (server/cloud/)

Each adapter runs as a plain JS module implementing the same contract as `WorkerProcess`. No Python, no venv, no child process.

- `server/cloud/registry.js` — Maps model prefixes (`minimax`, `elevenlabs`) to adapters.
- `server/cloud/minimax.js` — MiniMax adapter. SSE hex→PCM decode. 3-step clone (upload→clone→activate).
- `server/cloud/elevenlabs.js` — ElevenLabs adapter. Raw binary PCM. Single-step clone.

### Python Workers (src/nspeech/)

- `src/nspeech/worker_server.py` — uvicorn FastAPI worker. Port discovery via temp file.
- `src/nspeech/worker_routes.py` — Speech endpoint + voice management. Merges `extra_body` into adapter kwargs.
- `src/nspeech/engines/<name>.py` — Per-engine adapters implementing `generate()`, `list_voices()`, `clone()`, etc.

### Dashboard (web/)

Built with NUI (`lib/nui_wc2/`). Engine-aware navigation in `web/js/app.js`. Per-engine pages at `web/pages/<engine>/generate.html` and `web/pages/<engine>/voices.html`.

## Key Conventions

- **PCM contract:** All engines output s16le 24 kHz mono. Node transcodes.
- **Engine resolution:** `getEngine(model)` resolves cloud first, then local. Bare names like `minimax` work through cloud registry.
- **Cloud is stateless:** No `getWorker()`, no GPU exclusion, no lazy start. Just a JS module with a health check.
- **NUI conventions:** Use `data-action` for declarative wiring. Use `nui-button.setLoading()`. Wait for `customElements.whenDefined('nui-button')` before binding. Never use `<nui-button>` without an inner `<button>`. Replace `nui-click` with native `click` on the inner element.

## Session Management

Use `memory_store` and `memory_recall` to persist context across sessions. You forget everything between sessions. Store discoveries, patterns, decisions, and preferences immediately. At session end, store a handover summary.

Never run long-lived commands without a timeout. Always set explicit timeouts. If a task is inherently long-running, start it as a background process and poll for status.
