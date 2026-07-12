# nSpeech API Reference (V3)

nSpeech V3 is a multi-engine TTS service. A Node.js (Fastify) server proxies an OpenAI-compatible HTTP API, manages per-engine Python workers and cloud adapters, and transcodes raw PCM→compressed audio via bundled ffmpeg. This is the canonical reference for the `/v1/*` surface.

**Base URL:** `http://<host>:<port>` (default `http://127.0.0.1:2233`).

## Architecture (one line)

`client → Node (Fastify) → engine (Python worker or cloud adapter) → Node (ffmpeg) → client`

Every engine emits raw PCM (s16le, 24 kHz, mono). Node owns format transcoding. Cloud adapters run directly in Node — no Python process.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/audio/speech` | OpenAI-compatible TTS |
| POST | `/v1/audio/speech/clone` | One-shot TTS from uploaded reference (no persistence) |
| GET | `/v1/voices` | List voices on current (or `?engine=`) engine |
| POST | `/v1/voices/clone` | Persist a cloned voice (multipart) |
| POST | `/v1/voices/preview` | Temporary clone + preview audio (multipart) |
| POST | `/v1/voices/mix` | Blend two voices (JSON) |
| POST | `/v1/voices/preset` | Create/update a voice preset (JSON) |
| DELETE | `/v1/voices/:voice_id` | Delete a voice or preset |
| POST | `/v1/admin/engine` | Switch active engine (SSE progress) |
| GET | `/v1/admin/engines` | List engines with venv/loaded/type state |
| GET | `/v1/admin/status` | Worker manager state |
| GET | `/v1/admin/events` | Live event stream (SSE) — engine start/stop/error, history replay |
| POST | `/v1/audio/transcriptions` | Speech-to-text (proxied to nVoice) |
| POST | `/v1/audio/align` | Forced alignment (proxied to nVoice) |
| GET | `/health` | `{"status":"ok","version":"3.0.0","engine":"<active>"}` |
| GET | `/engine` | `{"engine":"<active>"}` |

---

## 1. TTS — `POST /v1/audio/speech`

OpenAI-compatible text-to-speech. Streams audio progressively or buffers fully (batch mode). Cloud and local engines share the same request shape.

### Request (JSON)

```json
{
  "model": "elevenlabs",
  "input": "Hello world.",
  "voice": "JBFqnCBsd6RMkjVDRZzb",
  "response_format": "mp3",
  "speed": 1.0,
  "instructions": "Speak warmly.",
  "extra_body": {
    "batch": false,
    "pitch": 0,
    "emotion": "calm",
    "expressiveness": 0.5,
    "stability": 0.5,
    "inference_steps": 4,
    "guidance_scale": 1.2,
    "seed": 42,
    "language": "en",
    "model": "eleven_turbo_v2_5",
    "blend": [{"voice_id": "af_heart", "weight": 30}, {"voice_id": "af_bella", "weight": 70}],
    "sample_rate": 24000,
    "channel": 1,
    "bitrate": 128000,
    "sound_effects": "spacious_echo"
  }
}
```

### Standard Fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `model` | string | `"nspeech"` | Engine selector. **Public values:** `"nspeech"` (dashboard-selected local engine), `"minimax"`, `"elevenlabs"`, `"gemini"`, `"xai"`. Cloud sub-models: `"minimax_speech_2_8_hd"`, `"elevenlabs_turbo_v2_5"`. Old local names (`kokoro`, `dots`, etc.) are rejected — use `"nspeech"` and switch via dashboard. |
| `input` | string | **required** | Text to synthesize. |
| `voice` | string | `"default"` | Voice ID. Engine-scoped: `af_heart` exists in Kokoro, not in Chatterbox. |
| `response_format` | string | `"mp3"` | `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`, `pcm_f32`. |
| `speed` | float | `1.0` | OpenAI range `0.25`–`4.0`. Engines may clamp (e.g. ElevenLabs: 0.7–1.2). |
| `instructions` | string | — | Natural-language style direction. Passed through where supported. |

### `extra_body` Extensions

All fields optional. Engines ignore unsupported fields silently — "if you support it, use it; if not, pass."

#### Voice Character

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `pitch` | number | -12..12 | Semitone pitch shift. |
| `emotion` | string | enum | `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `calm`, `whisper`, `fluent`. |
| `expressiveness` | number | 0..1 | Delivery intensity. 0 = flat, 1 = dramatic. |
| `stability` | number | 0..1 | Voice consistency. 0 = variable, 1 = steady. (ElevenLabs native.) |

#### Quality / Generation

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `batch` | boolean | — | `true` = render full audio before first byte. `false` = stream progressively. |
| `inference_steps` | int | 1..32 | Diffusion/flow NFE. Higher = better quality, slower. |
| `guidance_scale` | number | 0..3 | Voice adherence. Higher = stick closer to cloned voice. |
| `seed` | int | any | Determinstic sampling (best-effort). |

#### Model & Voice

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Sub-model variant. e.g. `speech-2.8-turbo` (MiniMax), `eleven_turbo_v2_5` (ElevenLabs). |
| `blend` | array | Up to 4 `{voice_id, weight}` pairs. Weight: 1–100. |

#### Audio Output

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `sample_rate` | int | 8000–44100 | Hz. Cloud providers support range; local engines fixed at 24000. |
| `channel` | int | 1, 2 | Mono or stereo. |
| `bitrate` | int | 32000–256000 | Encoded bitrate (mp3 only). |

#### Effects & Text

| Field | Type | Description |
|-------|------|-------------|
| `sound_effects` | string | `spacious_echo`, `auditorium_echo`, `lofi_telephone`, `robotic`. |
| `pronunciation` | object | `{tone: ["original/replacement"]}`. IPA, pinyin, jyutping, kana. |
| `ssml` | boolean | Interpret input as SSML. |
| `language` | string | ISO-639-1 hint or `auto`. |

### Response

Raw audio bytes with `Content-Type` per format. Every streaming response carries `X-Stream-Mode: native` (real incremental) or `X-Stream-Mode: chunked` (complete file sliced — batch mode or non-streaming cloud providers).

## Engine Capabilities

The `model` field selects a provider. Each provider has different strengths, price points, and supported `extra_body` fields.

### Choosing an engine

| Engine (`model`) | Type | Best for | TTFA | Voice cloning | Max text |
|---|---|---|---|---|---|
| `"nspeech"` | Local GPU | Privacy, offline, unlimited use | <1s | ✅ (engine-dependent) | Unlimited |
| `"minimax"` | Cloud | Best quality, sound effects, 332+ voices | ~1s | ✅ ($1.50/voice) | 10K chars |
| `"elevenlabs"` | Cloud | Voice consistency, 32 languages | ~1s | ✅ (instant) | 5K chars |
| `"gemini"` | Cloud | 80+ languages, auto-detect | ~1s | — | 5K chars |
| `"xai"` | Cloud | Grok integration | ~1s | ✅ | 5K chars |

The local engine behind `"nspeech"` is set via the dashboard (`POST /v1/admin/engine`). The local engines (kokoro, chatterbox, dots) are NOT exposed as model names — clients use `"nspeech"` and get whatever engine the dashboard selected.

### `extra_body` support by provider

| Field | nspeech (local) | MiniMax | ElevenLabs | Gemini | xAI |
|-------|-----------------|---------|------------|--------|-----|
| `pitch` | — | ✅ | — | — | — |
| `emotion` | engine-dependent | ✅ | — | — | — |
| `expressiveness` | engine-dependent | emotion map | `style` | — | — |
| `stability` | — | — | ✅ native | — | — |
| `batch` | engine-dependent | ✅ | ✅ | ✅ | ✅ |
| `inference_steps` | dots only | — | — | — | — |
| `guidance_scale` | dots only | — | `similarity_boost` | — | — |
| `seed` | dots only | — | ✅ | — | — |
| `blend` | kokoro only | ✅ `timbre_weights` | — | — | — |
| `language` | engine-dependent | ✅ `language_boost` | ✅ | ✅ (auto) | — |
| `sample_rate` | — | ✅ | ✅ | — | — |
| `sound_effects` | — | ✅ | — | — | — |

### Local engine details

When `model: "nspeech"`, the actual engine behind the request is the one selected via the dashboard. Each has unique capabilities:

| Engine | Voices | Strengths | `extra_body` notes |
|--------|--------|-----------|--------------------|
| Kokoro | 54 built-in + cloned/blended | Most stable, reliable for long-form narration, ONNX-based (fast startup) | `blend` via voice mixing endpoint; no `batch` support |
| Chatterbox | cloned only | Three models (Turbo 350M / Eng 500M / Multilingual 500M), 23 languages | `expressiveness` via `exaggeration`; model type via `extra_body.model` |
| dots.tts | cloned only | SOTA expressiveness, 48kHz native, best emotion range (2B AR model) | `batch`, `inference_steps`, `guidance_scale`, `seed`; slowest TTFA |

---

## 2. Voice Management — `/v1/voices`

Voice IDs are engine-scoped. Endpoints act on the engine specified by `?engine=` (use `nspeech`, `minimax`, `elevenlabs`, etc.). Omitting `?engine=` uses the current local engine.

### `GET /v1/voices`

```json
{
  "voices": [
    {"voice_id": "smart-lady", "name": "Smart Lady", "category": "preset", "voice_type": "preset", "engine": "gemini", "base_voice": "Kore", "instructions": "Speak in the cadence of a public intellectual."},
    {"voice_id": "Kore", "name": "Kore", "category": "builtin", "voice_type": "gemini_system", "engine": "gemini", "language": "auto", "description": "Warm"},
    {"voice_id": "my_voice", "name": "my_voice", "category": "cloned", "voice_type": "cloned", "engine": "minimax"}
  ]
}
```

Cloud adapters include `language`, `description`, `preview_url`, and `labels` where available. All engines include Node-managed voice presets as `voice_type: "preset"`.

### `POST /v1/voices/preset`

Create or update a voice preset — a saved combination of a base voice and instructions. Works for all engines (local and cloud). JSON body:

```json
{"engine": "gemini", "id": "smart-lady", "name": "Smart Lady", "voice": "Kore", "instructions": "Speak in the cadence of a public intellectual."}
```

Returns `{"voice_id": "smart-lady", "name": "Smart Lady", "voice_type": "preset", "engine": "gemini", "base_voice": "Kore", "instructions": "..."}`.

Presets appear in `GET /v1/voices` alongside built-in and cloned voices. When used as the `voice` in a TTS request, the preset's `voice` and `instructions` override the request — the client does not need to repeat them. Presets are stored in `presets/<engine>.json` at the project root.

### `POST /v1/voices/clone`

Multipart: `name`, `audio` (wav/mp3/...), `prompt_text` (optional), `model` (optional).

```json
{"voice_id": "my_voice", "name": "my_voice", "category": "cloned", "engine": "minimax"}
```

### `POST /v1/voices/preview`

Same multipart shape as clone, but voice is not persisted. Returns streaming MP3 audio so the client can hear the cloned voice before saving. ElevenLabs and MiniMax clone to a temporary voice, generate preview, then discard.

### `POST /v1/voices/mix`

```json
{"name": "my_blend", "voice_a": "af_heart", "voice_b": "af_bella", "ratio": 0.5}
```

Kokoro only. Cloud adapters return an error.

### `DELETE /v1/voices/:voice_id`

Removes the voice. Cloud adapters call the provider's delete endpoint.

---

## 3. Engine Switch — `POST /v1/admin/engine`

```json
{"engine": "dots"}
```

Returns SSE stream of status events:

```
event: status   data: {"stage":"unload_start","engine":"kokoro"}
event: status   data: {"stage":"unload_done","engine":"kokoro"}
event: status   data: {"stage":"load_start","engine":"dots"}
event: status   data: {"stage":"load_done","engine":"dots"}
event: result   data: {"engine":"dots","status":"switched"}
```

Cloud engines (MiniMax, ElevenLabs) emit a single `switch_done` status event since they have no worker lifecycle.

### `GET /v1/admin/engines`

```json
{
  "current": "kokoro",
  "engines": [
    {"name": "kokoro", "type": "local", "gpu": false, "venv_exists": true, "is_current": false, "is_loaded": false},
    {"name": "minimax", "type": "cloud", "health": "ready", "is_current": false, "is_loaded": true}
  ]
}
```

---

## 4. Errors

OpenAI-compatible shape:

```json
{"error": {"message": "...", "type": "invalid_request_error", "code": "voice_not_found", "param": "voice"}}
```

| HTTP | `type` | When |
|------|--------|------|
| 400 | `invalid_request_error` | Missing/invalid input, bad format, old local engine name (use `"nspeech"`) |
| 404 | `invalid_request_error` | Voice/model/engine not found |
| 409 | `invalid_request_error` (`engine_busy`) | Engine switch while requests active |
| 429 | `rate_limit_exceeded` | Cloud provider rate limit |
| 500 | `engine_error` | Engine failed during generation |
| 503 | `service_unavailable` | Worker crashed / starting / cloud unavailable |

---

## 5. Examples

```bash
# Local engine (whatever dashboard selected) — generate MP3
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"nspeech","input":"Hello.","voice":"af_heart","response_format":"mp3"}' \
  --output out.mp3

# MiniMax — stream MP3 with specific voice
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"minimax","input":"Hello.","voice":"English_expressive_narrator","response_format":"mp3"}' \
  --output out.mp3

# ElevenLabs — generate with voice settings
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"elevenlabs","input":"The first move sets everything in motion.","voice":"JBFqnCBsd6RMkjVDRZzb","extra_body":{"stability":0.3,"expressiveness":0.7}}' \
  --output out.mp3

# Create a voice preset
curl -X POST http://127.0.0.1:2233/v1/voices/preset \
  -H "Content-Type: application/json" \
  -d '{"engine":"gemini","id":"smart-lady","name":"Smart Lady","voice":"Kore","instructions":"Speak in the cadence of a public intellectual."}'

# Generate with a preset (auto-resolves to base voice + instructions)
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","input":"Hello.","voice":"smart-lady","response_format":"mp3"}' \
  --output out.mp3

# Clone a voice
curl -X POST http://127.0.0.1:2233/v1/voices/clone?engine=minimax \
  -F "name=my_voice" -F "audio=@reference.wav"

# Switch engine
curl -N -X POST http://127.0.0.1:2233/v1/admin/engine \
  -H "Content-Type: application/json" -d '{"engine":"minimax"}'

# List engines
curl http://127.0.0.1:2233/v1/admin/engines

# Live event stream
curl -N http://127.0.0.1:2233/v1/admin/events

# One-shot clone + generate
curl -X POST "http://127.0.0.1:2233/v1/audio/speech/clone?engine=minimax&response_format=mp3" \
  -F "name=temp" -F "audio=@reference.wav" -F "text=Hello from my cloned voice." \
  --output out.mp3

# Manager status
curl http://127.0.0.1:2233/v1/admin/status
```
