# nSpeech API Reference

nSpeech V3 is a multi-engine text-to-speech service. A Node.js proxy serves an
OpenAI-compatible HTTP API, manages per-engine Python worker processes, and
transcodes their raw PCM output to compressed formats via bundled ffmpeg. This
document is the canonical contract for the `/v1/*` surface.

## Architecture (one-paragraph mental model)

Every request flows: **client → Node (Fastify) → engine worker (Python/uvicorn) → Node (ffmpeg transcode) → client**.

The Node layer translates OpenAI-compatible request bodies into engine-native
worker bodies, routes to the correct worker (lazy-started, GPU-exclusive), and
owns all codec output. Workers emit raw PCM (s16le, 24 kHz, mono) and never
produce compressed audio themselves. This gives a single streaming/transcode
code path shared by every engine.

## Base URL & engine model

Base URL is `http://<host>:<port>` (default `http://127.0.0.1:8000`). The server
runs a single **active engine** at a time for voice management. Generation
requests resolve the engine from the `model` field (see Engine resolution below);
voice-management endpoints act on the active engine unless overridden with
`?engine=`.

`GET /engine` → `{"engine": "kokoro"}`. `GET /health` → `{"status":"ok","version":"3.0.0","engine":"<active>"}`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/audio/speech` | OpenAI-compatible TTS |
| POST | `/v1/audio/speech/clone` | One-shot TTS from an uploaded reference sample (no persistence) |
| GET | `/v1/voices` | List voices on the active (or `?engine=`) engine |
| POST | `/v1/voices/clone` | Persist a cloned voice (multipart) |
| POST | `/v1/voices/preview` | Temporary clone + preview audio (multipart) |
| POST | `/v1/voices/mix` | Blend two voices (JSON, Kokoro only) |
| DELETE | `/v1/voices/:voice_id` | Delete a voice |
| POST | `/v1/admin/engine` | Switch active engine (SSE progress events) |
| GET | `/v1/admin/engines` | List installed engines with venv/loaded state |
| GET | `/v1/admin/status` | Worker manager status |
| POST | `/v1/audio/transcriptions` | Speech-to-text (proxied to nVoice) |
| POST | `/v1/audio/align` | Forced alignment (proxied to nVoice) |
| GET | `/health` · `/engine` | Service info |

---

## 1. TTS — `POST /v1/audio/speech`

### Request body (JSON)

```json
{
  "model": "kokoro",
  "input": "Hello world.",
  "voice": "af_heart",
  "response_format": "mp3",
  "speed": 1.0,
  "instructions": "Speak clearly and warmly.",
  "extra_body": {
    "offline": false,
    "exaggeration": 0.5,
    "steps": 4,
    "guidance_scale": 1.2,
    "language": "de",
    "seed": 42,
    "model": "turbo"
  }
}
```

### Standard fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `model` | string | active engine | Engine selector. See Engine resolution. |
| `input` | string | *required* | Text to synthesize. |
| `voice` | string | `"default"` | Voice ID (builtin, cloned, blended). Engine-scoped. |
| `response_format` | string | `"mp3"` | `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`, `pcm_f32`. |
| `speed` | float | `1.0` | Speaking speed. OpenAI range `0.25`–`4.0`; engines may clamp. |
| `instructions` | string | — | Natural-language style direction. Passed through as `instruct_text` where supported (CosyVoice, dots). |

### `extra_body` extensions

| Field | Applies to | Notes |
|-------|-----------|-------|
| `offline` | all | `true` = buffer full audio before responding (`X-Stream-Mode: chunked`). `false` (default) = stream as generated (`X-Stream-Mode: native`). |
| `exaggeration` | Chatterbox, Kokoro | Expressiveness. Default `0.5`. |
| `steps` | dots (AR) | Diffusion NFE. Default `4`. |
| `guidance_scale` | dots | Classifier-free guidance. Default `1.2`. |
| `seed` | dots | RNG seed. Default `42`. |
| `language` | multilingual engines | ISO-639-1 hint (`de`, `zh`, ...). |
| `model` | Chatterbox | Sub-model: `turbo` (350M, paralinguistic), `eng` (500M), `mtl` (500M multilingual). Default `eng`. |

### Response

Raw audio bytes with `Content-Type` per format:

| `response_format` | Content-Type |
|-------------------|--------------|
| `mp3` | `audio/mpeg` |
| `opus` | `audio/opus` |
| `aac` | `audio/aac` |
| `flac` | `audio/flac` |
| `wav` | `audio/wav` |
| `pcm` | `audio/pcm` (OpenAI: 24 kHz 16-bit signed LE mono) |
| `pcm_f32` | `application/octet-stream` (nSpeech native: 24 kHz float32 mono) |

Every streaming response carries `X-Stream-Mode: native` (real incremental
generation) or `X-Stream-Mode: chunked` (complete file sliced — cloud adapters
or `extra_body.offline: true`). Clients needing low-latency incremental delivery
should check this header. Streaming is best-effort and non-resumable.

### Engine resolution

`resolveEngine(model)`:
- Direct match against `kokoro`, `cosyvoice`, `chatterbox`, `dots`.
- Else the prefix before the first `_` (e.g. `cosyvoice_0.5b` → `cosyvoice`, `dots_mf` → `dots`).
- Else falls back to the active engine.
- Cloud-prefixed models (`openai_*`, `elevenlabs_*`) resolve to `null` (Phase 8, not implemented).

---

## 2. One-shot TTS from reference — `POST /v1/audio/speech/clone`

Clones a voice from an uploaded audio sample and immediately synthesizes text in
that voice. The voice is **not persisted**. Equivalent to `/v1/voices/preview`
plus generation; Node forwards the multipart body to the worker's preview
endpoint and transcodes the returned PCM.

### Request (multipart/form-data)

Because Node forwards the raw multipart stream, the engine is resolved from a
**query parameter** rather than the body:

```
POST /v1/audio/speech/clone?engine=dots&response_format=mp3
Content-Type: multipart/form-data

input: Hello world
audio: <binary wav/mp3>
prompt_text: Hello world        # optional transcript
extra_body[steps]: 4
```

| Query param | Default | Notes |
|-------------|---------|-------|
| `engine` / `model` | active engine | Selects the worker. `model` is resolved via the same rules as `/v1/audio/speech`. |
| `response_format` | `mp3` | Output format. |

Response: raw audio bytes (always `X-Stream-Mode: chunked`).

---

## 3. Voice management — `/v1/voices`

Voice IDs are **engine-scoped**: a voice `af_heart` exists in Kokoro, not in
CosyVoice. Voice-management endpoints act on the active engine, or the engine
named by `?engine=`.

### `GET /v1/voices`

```json
{
  "engine": "kokoro",
  "voices": [
    {"voice_id": "af_heart", "name": "af_heart", "category": "builtin", "voice_type": "builtin", "engine": "kokoro"},
    {"voice_id": "my_voice", "name": "my_voice", "category": "cloned", "voice_type": "cloned", "engine": "kokoro"}
  ]
}
```

Categories: `builtin` (engine-native), `cloned` (persisted from reference), `blended` (Kokoro mix), `preview` (temporary clone).

### `POST /v1/voices/clone` (persistent)

Multipart form: `name`, `audio` (wav/mp3/...), `engine` (optional), `model` (optional), `prompt_text` (optional). If `prompt_text` is omitted, the worker auto-transcribes the reference audio with a local Whisper model and exposes the result in the `X-STT-Transcript` response header (preview) and the JSON `prompt_text` field (clone).

```json
{
  "voice_id": "my_voice",
  "name": "my_voice",
  "engine": "dots",
  "cache_file": "venv/dots/voices/my_voice.dots.pt",
  "prompt_text": "Hello world.",
  "clone_time_ms": 870
}
```

### `POST /v1/voices/preview` (temporary)

Same multipart shape as clone, but the voice is not persisted. Returns streaming
audio (Node transcodes worker PCM → `audio/mpeg`) so the client can hear the
cloned voice before deciding to save. The `X-STT-Transcript` header carries the
Whisper transcript of the reference audio.

### `POST /v1/voices/mix` (Kokoro only)

```json
{"name": "my_blend", "voice_a": "af_heart", "voice_b": "af_bella", "ratio": 0.5}
```

Returns `{"voice_id":"my_blend","name":"my_blend","category":"blended","engine":"kokoro"}`.

### `DELETE /v1/voices/:voice_id`

Removes the voice cache. Returns `{"deleted": "<voice_id>", "files": [...]}` or 404 if not found.

---

## 4. Engine switch — `POST /v1/admin/engine`

Switches the active engine, unloading any conflicting GPU worker first. Returns
a Server-Sent Events stream of status events.

```json
POST /v1/admin/engine
{"engine": "dots"}
```

SSE event sequence:

```
event: status   data: {"stage": "unload_start", "engine": "kokoro"}
event: status   data: {"stage": "unload_done",  "engine": "kokoro"}
event: status   data: {"stage": "load_start",   "engine": "dots"}
event: status   data: {"stage": "load_done",    "engine": "dots"}
event: result   data: {"engine": "dots", "status": "switched"}
```

- **Serialized** through a mutex; concurrent switches queue, do not race.
- Returns **409** `engine_busy` if the current engine has in-flight requests.
- **In-flight requests to the old engine are killed on switch** — clients must
  handle mid-stream disconnects during a switch.

### `GET /v1/admin/engines`

```json
{
  "current": "kokoro",
  "engines": [
    {"name": "kokoro", "gpu": false, "venv_exists": true, "is_current": true, "is_loaded": true},
    {"name": "cosyvoice", "gpu": true, "venv_exists": true, "is_current": false, "is_loaded": false}
  ]
}
```

### `GET /v1/admin/status`

Detailed worker manager state: `{ currentEngine, workers: { <name>: {state, inFlight, ...} } }`.

---

## 5. STT & alignment — `POST /v1/audio/transcriptions` · `/v1/audio/align`

Proxied to a separate nVoice service (configured via `nvoice_url` in
`config.json`). Both are multipart endpoints; Node forwards the raw body and
streams the response back unchanged. Returns **503** `nvoice_not_configured` if
no nVoice URL is set, **504** on timeout, **502** on proxy error.

These endpoints are independent of the TTS engine — no engine worker is spawned.
A local Whisper model is also available inside engine workers for reference-audio
auto-transcription during voice cloning (no nVoice dependency).

---

## 6. Engines

| Engine | Hardware | Cloning | Notable `extra_body` / fields |
|--------|----------|---------|-------------------------------|
| **kokoro** | CPU | Stubbed (falls back to default voice) | `speed`, voice blending (`/v1/voices/mix`). 54 builtin voices. English. |
| **cosyvoice** | GPU (~3.5 GB) | Zero-shot | `instructions`/`instruct_text`, `language`, `speed`. Multilingual (9 langs). 0.5B model has prosody jitter. |
| **chatterbox** | GPU (~10 GB) | Zero-shot | `model` (`turbo`/`eng`/`mtl`), `exaggeration`, `language`. Turbo supports paralinguistic tags (`[laugh]`, `[cough]`). |
| **dots** | GPU | Zero-shot | `steps`, `guidance_scale`, `seed`, `instructions`. AR flow model. Slow cold-start (~22s). |

GPU engines are mutually exclusive — only one GPU engine is resident at a time.
CPU engines (kokoro) coexist. Workers lazy-start on first request.

---

## 7. Errors

All errors use the OpenAI-compatible shape:

```json
{
  "error": {
    "message": "Voice 'af_heart' not found in engine cosyvoice",
    "type": "invalid_request_error",
    "code": "voice_not_found",
    "param": "voice"
  }
}
```

| HTTP | `type` | When |
|------|--------|------|
| 400 | `invalid_request_error` | Missing/invalid input, unknown format |
| 404 | `invalid_request_error` | Voice/model/engine not found |
| 409 | `invalid_request_error` (`engine_busy`) | Engine switch while requests in flight |
| 429 | `rate_limit_exceeded` | Cloud provider rate limit |
| 500 | `engine_error` | Engine failed during generation |
| 503 | `service_unavailable` | Worker crashed / starting / `engine_starting` / `venv_missing` |
| 502 / 504 | `engine_error` / `service_unavailable` | nVoice proxy failure / timeout |

Common `code`s: `missing_input`, `engine_not_found`, `venv_missing`,
`engine_starting`, `engine_start_failed`, `engine_busy`, `nvoice_not_configured`,
`nvoice_timeout`, `nvoice_error`.

---

## 8. Examples

```bash
# Generate (MP3, streamed)
curl -X POST http://127.0.0.1:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","input":"Hello world.","voice":"af_heart","response_format":"mp3"}' \
  --output out.mp3

# Generate (dots with tuning)
curl -X POST http://127.0.0.1:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"dots","input":"Hello.","voice":"my_voice","extra_body":{"steps":8,"guidance_scale":1.5,"seed":42}}' \
  --output out.mp3

# Clone a voice (persistent)
curl -X POST http://127.0.0.1:8000/v1/voices/clone?engine=cosyvoice \
  -F "name=my_voice" -F "audio=@reference.wav" -F "prompt_text=Hello world."

# List voices
curl http://127.0.0.1:8000/v1/voices

# Switch engine (SSE stream)
curl -N -X POST http://127.0.0.1:8000/v1/admin/engine -H "Content-Type: application/json" -d '{"engine":"dots"}'

# Available engines
curl http://127.0.0.1:8000/v1/admin/engines
```
