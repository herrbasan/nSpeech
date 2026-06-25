# nSpeech Audio API — Development Plan

**Version: 3.0.0** (branch `v3.0.0`)  
Status: draft  
Date: 2026-06-25  
Depends on: [AUDIO_API_PLAN.md](AUDIO_API_PLAN.md)

## 1. Goal

Refactor nSpeech so it exposes the unified OpenAI-compatible audio API defined in `AUDIO_API_PLAN.md`, with a Node.js management layer that can spawn, kill, and switch between per-engine Python workers at runtime.

This architecture becomes the blueprint for nVoice.

## 2. Why a Node management layer

- Node is the runtime for the LLM Gateway and Arena Slides server. One runtime across the stack reduces ops cost.
- `child_process` fits naturally around per-engine Python venvs.
- SSE/WebSocket progress events for engine switching are idiomatic.
- The Python venv problem disappears: the server process is never tied to a single engine venv.

What stays Python:

- All TTS adapters in `src/nspeech/engines/`.
- Engine-specific inference, chunking, voice cache I/O.
- A thin worker entry point that loads an adapter and speaks JSONL over stdin/stdout.

## 3. Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Node.js nSpeech API Server                                  │
│  • Fastify HTTP / WebSocket endpoints                        │
│  • OpenAI-compatible request translation                     │
│  • Engine worker manager (spawn / kill / switch)             │
│  • Proxy to nVoice for STT and forced alignment              │
│  • Config from config.json + .env API keys                   │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTP relay (request body → worker, audio → client)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Per-engine Python HTTP Worker                               │
│  (venv/<engine>/env/Scripts/python -m nspeech.worker_server) │
│  • Loads adapter from src/nspeech/engines/<engine>.py        │
│  • Own streaming/transcoding strategy                        │
│  • Exposes engine-native HTTP endpoints                      │
└──────────────────────────────────────────────────────────────┘
```

Node is a thin translation layer. It does not generate, transcode, or stream audio itself. It validates the OpenAI-compatible surface, picks the right worker, and relays the request/response. This makes local engines and cloud providers structurally identical from Node's perspective.

## 4. Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| Runtime | Node 22, ESM, no TypeScript | Matches Gateway stack; prime directive prefers bare platform. |
| HTTP framework | Fastify | Lightweight, native JS, streaming-friendly. |
| Worker interface | HTTP server per engine | Engine owns streaming, transcoding, and multipart handling. Node just relays. |
| Transcoding | Inside Python worker via PyAV | Engine chooses its own output strategy; Node remains transport-only. |
| STT / alignment | Proxied to nVoice service | nVoice gets the same refactor later; stays separate for now. |
| Engine switching | Kill previous GPU worker, spawn new one | Only one GPU engine resident at a time; CPU engines can coexist. |
| Config | `config.json` for service config, `.env` for secrets | Secrets stay out of committed files. |
| Voice cache | Unchanged on disk | `venv/<engine>/voices/` remains the source of truth. |

## 5. Phases

### Phase 0: Scaffold Node server (no engine logic)

Goal: a running Fastify server that can serve the dashboard and proxy static files.

Files:
- `server/package.json`
- `server/index.js` — Fastify bootstrap, static file mounts, graceful shutdown.
- `server/config.js` — load `config.json` + `.env`.
- `server/logger.js` — nLogger-compatible JSON Lines output.

Verify:
- `node server/index.js` serves `web/index.html` at the configured port.
- Existing `run.py` and Python server remain untouched.

### Phase 1: Python worker HTTP server

Goal: a Python process per engine that exposes an engine-native HTTP API.

Files:
- `src/nspeech/worker_server.py` — FastAPI/uvicorn worker entry point.
- `src/nspeech/worker_routes.py` — routes for `/v1/audio/speech`, `/v1/voices/*`, `/health`.

Worker endpoints (engine-native, not OpenAI-compatible):
- `POST /v1/audio/speech` — accepts engine-specific JSON + optional multipart, streams audio.
- `POST /v1/voices/clone` — multipart clone, persists cache.
- `POST /v1/voices/preview` — multipart clone, no persistence.
- `POST /v1/voices/mix` — blend two voices.
- `GET /v1/voices` — list voices.
- `DELETE /v1/voices/{voice_id}` — delete voice cache.
- `GET /health` — readiness.

Worker startup:
```bash
venv/kokoro/env/Scripts/python -m nspeech.worker_server --engine kokoro --port 0
```
`--port 0` lets the OS assign a port. The worker writes its bound port to a temp file
(`%TEMP%/nspeech-<engine>-<pid>.port`) and also prints it on stdout as the first line.
Node reads the temp file (authoritative); stdout is a fallback for debugging.

Rationale: stdout-only port discovery is fragile — engine libraries (transformers,
torch, onnxruntime) write warnings to stdout and can interleave with or delay the
port line. The temp file is deterministic and race-free.

Adapter changes:
- Add `list_voices() -> list[dict]` to `TTSAdapterProtocol`.
- Add `unload() -> None` for explicit resource cleanup.
- Add `is_loaded() -> bool` so `/health` can report model load state accurately.
- `generate()` stays unchanged: yields `(pcm_tensor, is_final)`.

Verify:
- `python -m nspeech.worker_server --engine kokoro --port 9001` starts.
- `GET http://127.0.0.1:9001/v1/voices` returns voices.
- Temp file appears and contains the correct port.

### Phase 2: Engine worker manager in Node

Goal: Node can start, stop, and route HTTP requests to engine workers.

Files:
- `server/engine/registry.js` — map engine name to venv path and worker module.
- `server/engine/worker.js` — `WorkerProcess` class wrapping a child HTTP server.
- `server/engine/manager.js` — `EngineManager` with `getWorker(engine)`, `switchEngine(engine)`, `unload(engine)`.

Registry format (`server/engine/registry.json`):
```json
{
  "kokoro": {
    "venv_python": "venv/kokoro/env/Scripts/python.exe",
    "worker_module": "nspeech.worker_server",
    "gpu": false
  },
  "cosyvoice": {
    "venv_python": "venv/cosyvoice/env/Scripts/python.exe",
    "worker_module": "nspeech.worker_server",
    "gpu": true
  }
}
```

Manager behavior:
- Lazy start on first request for an engine.
- Spawns worker with `--port 0`, reads the bound port from the temp file.
- Polls `/health` before marking worker ready. `/health` reports `warming` until the
  adapter's model is loaded (first request triggers load), then `ready`. Node does not
  mark a GPU worker ready until `/health` returns `ready` — or accepts that the first
  request after `warming` will be slow and lets the client wait.
- If a GPU engine is requested while another GPU engine is loaded, unload the old one first.
- CPU engines can stay loaded alongside each other.
- Crash detection: if a worker exits unexpectedly, clear it from cache and return 503.
- **Stream stall detection:** Node wraps every relayed response in a byte-flow watchdog.
  If no bytes arrive for `STREAM_TIMEOUT` seconds (default 30, configurable per engine),
  Node aborts the upstream request, closes the client connection, and marks the worker
  unhealthy. This catches GPU deadlocks that don't exit the process.
- **Request cancellation:** Node passes an `AbortController` to every upstream fetch.
  When the client disconnects mid-stream, Node aborts the upstream request immediately.
  The worker must detect client disconnect (FastAPI `Request.is_disconnected()`) and stop
  generation — a cancelled 30s GPU request must not run to completion.
- **In-flight tracking:** each worker maintains an atomic request counter. Engine switch
  and unload are blocked while the counter is non-zero (see Phase 6).
- **Process group kill:** workers are spawned in a process group. On Node shutdown
  (SIGINT/SIGTERM), Node kills the entire group, not just the child PID. On startup,
  Node sweeps for stale `nspeech.worker_server` processes (matching the temp-file
  pattern) and kills them before spawning new ones.
- Node relays requests by forwarding the HTTP stream to the worker URL.

Verify:
- Node can spawn a Kokoro worker and proxy `GET /v1/voices`.
- Node can switch from Kokoro to CosyVoice and back.
- Killing a worker mid-request causes Node to return 503 to the client.
- Client disconnect mid-stream causes the worker to stop generating (check GPU idle).

### Phase 3: OpenAI-compatible TTS endpoints

Goal: implement `/v1/audio/speech` and `/v1/audio/speech/clone`.

Files:
- `server/api/speech.js` — POST /v1/audio/speech.
- `server/api/speech-clone.js` — POST /v1/audio/speech/clone.
- `server/api/formats.js` — response_format → content-type mapping.

Behavior:
1. Validate and normalize the OpenAI-compatible request body.
2. Resolve engine from `model` (e.g. `kokoro`, `cosyvoice_0.5b`, `openai_tts_1`).
3. Get or start worker for that engine.
4. Translate OpenAI fields to engine-native fields:
   - `input` → `text`
   - `voice` → `voice_name`
   - `response_format` → `output_format`
   - `speed` → engine-specific speed param
   - `instructions` → engine-specific style param
   - `extra_body` → forwarded as-is
5. Forward the request body to the worker's `POST /v1/audio/speech`.
6. Stream the worker's response back to the client with the correct `Content-Type`.

Node does **not** transcode. The worker decides how to produce `mp3`, `opus`, `pcm`, etc. Node may need to rewrite headers if the worker returns a non-OpenAI `Content-Type` for `pcm`.

Verify:
- `curl` to `/v1/audio/speech` returns audio bytes.
- Browser dashboard generate page works with new endpoint.

### Phase 4: Voice management endpoints

Goal: implement `/v1/voices/*`.

Files:
- `server/api/voices.js` — GET, POST clone, POST preview, POST mix, DELETE.

Behavior:
- `GET /v1/voices` forwards to the active engine worker's `/v1/voices`.
- `POST /v1/voices/clone` forwards multipart upload to the active engine worker.
- `POST /v1/voices/preview` forwards multipart upload to the active engine worker.
- `POST /v1/voices/mix` forwards JSON to the active engine worker.
- `DELETE /v1/voices/{id}` forwards to the active engine worker.

Node may normalize response shapes (e.g. rename `name` to `voice_id` for OpenAI clients).

Verify:
- Clone a voice and see it in `/v1/voices`.
- Mix two Kokoro voices.

### Phase 5: STT / alignment proxy

Goal: Node forwards STT and alignment requests to nVoice.

Files:
- `server/api/transcriptions.js` — POST /v1/audio/transcriptions.
- `server/api/align.js` — POST /v1/audio/align.

Behavior:
- Parse multipart upload in Node.
- Forward to `NVOICE_URL/v1/audio/transcriptions` or `/v1/audio/align`.
- Stream response back unchanged.

In the future nVoice will get the same HTTP-worker refactor, at which point it becomes just another engine in the registry.

Verify:
- Transcription of a WAV file returns OpenAI-shaped JSON.

### Phase 6: Engine switch endpoint with progress events

Goal: clients can switch engines and watch progress.

Files:
- `server/api/admin.js` — POST /v1/admin/engine.

Request:
```json
POST /v1/admin/engine
{"engine": "dots"}
```

Response: SSE stream.

```
event: status
data: {"stage": "unload_start", "engine": "kokoro"}

event: status
data: {"stage": "unload_done", "engine": "kokoro"}

event: status
data: {"stage": "load_start", "engine": "dots"}

event: status
data: {"stage": "load_done", "engine": "dots"}
```

Behavior:
- **Serialized:** engine switches are queued through a mutex. Two concurrent switch
  requests do not race — the second waits for the first to complete.
- **In-flight check:** if the current engine's worker has active requests (non-zero
  in-flight counter), return 409 Conflict with a clear error message. "Active" means
  any request still streaming or processing, not just TTS — voice clones and mixes
  count too.
- Otherwise unload current GPU engine (if any), spawn requested engine, run a smoke
  `list_voices` call.
- Update `current_engine` state.
- **In-flight requests to the old engine are killed on switch.** This is intentional.
  Clients must handle mid-stream disconnects during a switch. The dashboard should
  disable the switch button while generation is active.

Verify:
- Switch engines via curl and receive SSE events.
- Dashboard reflects new active engine.
- Concurrent switch requests are serialized, not interleaved.
- Switch while a stream is active returns 409.

### Phase 7: Dashboard migration

Goal: NUI dashboard talks to the new Node API.

Files to touch:
- `web/js/app.js` — engine-aware navigation.
- `web/pages/*/generate.html` and `web/pages/*/voices.html` — update fetch URLs from legacy `/tts` and `/voices/*` to `/v1/audio/speech` and `/v1/voices/*`.
- Add engine switch UI to `web/pages/home.html` or sidebar.

Verify:
- Generate audio.
- Clone voice.
- Switch engine and see new pages in sidebar.

### Phase 8: Cloud provider adapters

Goal: treat OpenAI, ElevenLabs, Azure, etc. as engines.

Cloud adapters only need an HTTP client — no model weights, no GPU, no venv. Spawning
a Python process per cloud provider is heavyweight and pointless. Cloud adapters run
**directly in Node** as native fetch-based modules, not as Python workers.

Files:
- `server/cloud/openai_tts.js` — calls OpenAI `/v1/audio/speech`, streams response.
- `server/cloud/elevenlabs.js` — calls ElevenLabs API.
- `server/cloud/registry.js` — maps `model` prefix to cloud adapter (e.g. `openai_*` → openai_tts).

Cloud adapters implement the same relay contract as worker forwarding:
- Accept the OpenAI-compatible request body (minimal translation needed).
- Stream the provider's response back to the client.
- Set `X-Stream-Mode: chunked` header (see §11) since cloud TTS returns complete files.
- Read API keys from `.env` at startup; fail fast if missing.

The registry in `server/engine/manager.js` checks cloud first: if `model` matches a
cloud prefix, route to the Node cloud adapter. Otherwise route to the Python worker.

Verify:
- Request with `model: openai_tts_1` calls OpenAI and returns audio through Node.
- No Python process is spawned for cloud models.

### Phase 9: Decommission old Python server

Goal: remove FastAPI server once Node server is fully functional.

Files to remove or archive:
- `src/nspeech/server.py` — archive or delete.
- `run.py` — replace with a Node launcher, or keep as a thin wrapper that calls `node server/index.js`.

Keep:
- `src/nspeech/tts.py` until all routing is through workers, then remove or shrink.
- `src/nspeech/engines/` unchanged.

## 6. Worker HTTP contract

Each worker exposes the following endpoints. The request/response shapes are engine-native, not OpenAI-compatible.

### `GET /health`

```json
{"status": "ok", "engine": "kokoro"}
```

### `GET /v1/voices`

```json
{
  "voices": [
    {"voice_id": "af_heart", "name": "af_heart", "category": "builtin"},
    {"voice_id": "my_voice", "name": "my_voice", "category": "cloned"}
  ]
}
```

### `POST /v1/audio/speech`

Engine-native request body:
```json
{
  "text": "Hello world.",
  "voice_name": "af_heart",
  "output_format": "mp3",
  "speed": 1.0,
  "extra_body": {
    "offline": false,
    "exaggeration": 0.5
  }
}
```

Response: raw audio bytes with `Content-Type: audio/mpeg`.

### `POST /v1/voices/clone`

Multipart form:
```http
Content-Type: multipart/form-data

name: my_voice
audio: <binary wav/mp3>
prompt_text: Hello world
```

Response:
```json
{
  "voice_id": "my_voice",
  "name": "my_voice",
  "category": "cloned"
}
```

### `POST /v1/voices/preview`

Same as clone, but temporary.

### `POST /v1/voices/mix`

```json
{
  "name": "my_blend",
  "voice_a": "af_heart",
  "voice_b": "am_michael",
  "ratio": 0.5
}
```

### `DELETE /v1/voices/{voice_id}`

Response: `204 No Content` or `{"deleted": "my_voice"}`.

## 7. PCM contracts

| Format | Producer | Notes |
|--------|----------|-------|
| `pcm` | Worker | OpenAI-compatible PCM: 24kHz 16-bit signed little-endian mono. This is the default interpretation of `response_format: pcm`. |
| `pcm_f32` | Worker | nSpeech native: 24kHz float32 mono. Request via `response_format: pcm_f32`. Internal clients (dashboard, Arena Slides) use this to skip a conversion. |
| `mp3/opus/aac/flac/wav` | Worker | Engine chooses encoder (PyAV, soundfile, etc.). |

Node only rewrites headers if necessary. It never transcodes.

Decision: `pcm` is always OpenAI 16-bit LE. OpenAI clients expect this; breaking it
defeats the purpose of compatibility. Native float32 is opt-in via `pcm_f32`.

## 8. Config shape

`config.json`:
```json
{
  "host": "127.0.0.1",
  "port": 8000,
  "default_engine": "kokoro",
  "nvoice_url": "https://127.0.0.1:2244",
  "voice_dir": "venv/{engine}/voices",
  "model_dir": "venv/{engine}/models",
  "log_level": "INFO"
}
```

`.env`:
```
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...
```

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Worker spawn latency is high (5–10s for GPU) | Keep lazy loading; engine switch is explicit and sends progress events. |
| Multiple HTTP servers on localhost | Dynamic port allocation (`--port 0`) + temp-file port discovery. |
| Worker crashes mid-stream | Node detects exit, returns 503, and respawns on next request. |
| Worker hangs mid-stream (GPU deadlock, no exit) | Byte-flow watchdog in Node relay: abort upstream after `STREAM_TIMEOUT` seconds of no data. |
| Orphaned workers on Node crash | Process group kill on shutdown + stale-process sweep on startup. |
| Client disconnect wastes GPU | AbortController on upstream fetch + worker checks `is_disconnected()`. |
| Concurrent engine switches race | Switch mutex serializes all switch requests. |
| Cloud adapter credentials | `.env` only; fail fast at startup if required key missing. |
| Old dashboard broken during migration | Keep Python server running on a different port until Phase 9. |
| Voice ID collision across engines | Voice IDs are engine-scoped; cross-engine voice requests fail with a clear error (see API plan §7). |

## 10. Error response schema

All error responses (from Node, workers, and cloud adapters) use the OpenAI shape:

```json
{
  "error": {
    "message": "Voice 'af_heart' not found in engine cosyvoice_0.5b",
    "type": "invalid_request_error",
    "code": "voice_not_found",
    "param": "voice"
  }
}
```

Common error types: `invalid_request_error`, `engine_error`, `rate_limit_exceeded`,
`service_unavailable`. Workers translate engine-specific exceptions into these types.
Node wraps worker errors that don't match the schema.

## 11. Streaming honesty

Local engines stream real incremental generation. Cloud adapters return complete files.
Both support `stream: true`, but clients should know which they're getting.

Node sets a response header on all streaming responses:

| Header | Value | Meaning |
|--------|-------|---------|
| `X-Stream-Mode` | `native` | Bytes arrive as they are generated (local engines). |
| `X-Stream-Mode` | `chunked` | Complete file sliced into chunks (cloud adapters, or `offline: true`). |

Clients that need true incremental delivery (e.g. low-latency playback) should check
this header and prefer `native` engines.

## 12. Definition of done

- `node server/index.js` starts and serves the dashboard.
- `/v1/audio/speech` works for local and cloud engines.
- `/v1/voices/*` works for clone/preview/mix/list/delete.
- `/v1/admin/engine` switches engines with SSE progress.
- `/v1/audio/transcriptions` and `/v1/audio/align` proxy to nVoice.
- Python FastAPI server is removed.
- `docs/AUDIO_API_PLAN.md` and `docs/AUDIO_API_DEV_PLAN.md` are accurate.
