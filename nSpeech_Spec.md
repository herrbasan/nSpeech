# nSpeech V3 — Technical Specification

**Audience:** LLM agents, developers modifying the codebase
**Scope:** Complete architecture, data flow, and implementation details
**Status:** Living document — updated as the codebase evolves

---

## 1. System Overview

nSpeech is a multi-engine Text-to-Speech service with a unified OpenAI-compatible API. It abstracts local GPU engines (Kokoro, Chatterbox, dots.tts) and cloud providers (MiniMax, ElevenLabs, Gemini, xAI) behind a single HTTP surface.

### Design Principles

- **One API, many engines:** Clients speak OpenAI-compatible JSON. nSpeech translates to engine-specific calls.
- **Node owns transport, Python owns generation:** Node.js handles routing, transcoding, process lifecycle. Python workers run TTS models.
- **PCM is the intermediate format:** All engines emit s16le 24kHz mono PCM. Node transcodes to MP3/Opus/AAC via ffmpeg.
- **Fail fast:** No defensive coding, no fallback defaults. Missing config crashes at startup.
- **GPU exclusion:** Only one GPU engine resident at a time. Hard switch, not multiplex.

### Hardware Target

- **Deployment:** BADKID server, RTX 4090 (24GB VRAM)
- **VRAM budget:** 4GB for TTS (12GB reserved for Gemma 4 LLM, 4-6GB for STT service)
- **Engine strategy:** Kokoro (always available, slim) + Chatterbox Turbo (primary GPU engine, ~2GB) + cloud providers (stateless)

---

## 2. Architecture

### 2.1 Process Topology

```
┌─────────────────────────────────────────┐
│  Client (dashboard / curl / Gateway)    │
│  POST /v1/audio/speech                  │
│  {model, input, voice, response_format} │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  Node.js Fastify Server (port 2233)     │
│  ├─ server/index.js      — bootstrap    │
│  ├─ server/config.js     — config.json  │
│  ├─ server/api/speech.js — TTS handler  │
│  ├─ server/api/voices.js — voice mgmt   │
│  ├─ server/api/admin.js  — engine switch│
│  ├─ server/engine/manager.js — routing  │
│  ├─ server/engine/worker.js — Python    │
│  │   process wrapper                    │
│  ├─ server/cloud/*.js    — cloud        │
│  │   adapters (minimax, elevenlabs,     │
│  │   gemini, xai)                       │
│  ├─ server/transcode.js  — ffmpeg       │
│  └─ server/presets.js    — voice        │
│      preset store                       │
└─────────────────┬───────────────────────┘
                  │ spawns / HTTP relay
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌─────────────────────┐
│ Python Worker │   │ Cloud Provider API  │
│ (uvicorn)     │   │ (HTTPS)             │
│ ├─ worker_    │   │                     │
│ │  server.py  │   │                     │
│ ├─ worker_    │   │                     │
│ │  routes.py  │   │                     │
│ ├─ engines/   │   │                     │
│ │  kokoro.py  │   │                     │
│ │  chatterbox │   │                     │
│ │  dots.py    │   │                     │
│ └─ tts.py     │   │                     │
│   (factory)   │   │                     │
└───────────────┘   └─────────────────────┘
```

### 2.2 Layer Responsibilities

| Layer | Owns | Does Not Own |
|-------|------|--------------|
| **Node.js** | HTTP routing, engine resolution, transcoding, process lifecycle, GPU exclusion, stream stall detection, request cancellation, preset resolution | TTS generation, voice cloning, model weights |
| **Python Worker** | Model loading, speech generation, voice management (list/clone/mix/preview/delete) | HTTP routing, transcoding, process management |
| **Cloud Adapter** | API key management, provider-specific request formatting, SSE/binary response parsing | PCM transcoding (Node does this), process management |

---

## 3. Engine Strategy (Target State)

### 3.1 Production Engine Set

| Engine | Type | VRAM | Role | Status |
|--------|------|------|------|--------|
| **Kokoro** | Local (ONNX CUDA) | ~500MB | Always-available workhorse | Primary CPU/slim GPU option |
| **Chatterbox Turbo** | Local (PyTorch) | ~2GB | Primary GPU quality engine | Candidate for permanent GPU residency |
| **MiniMax** | Cloud | — | High-quality cloud option | Active |
| **ElevenLabs** | Cloud | — | Premium cloud option | Active |
| **Gemini** | Cloud | — | Instruction-driven style | Active |
| **xAI** | Cloud | — | Alternative cloud option | Active |

### 3.2 Deprecated / Abandoned Engines

| Engine | Reason | Date |
|--------|--------|------|
| **CosyVoice** | Audible artifacts in both streaming and batch mode. Root cause never identified. | Removed 2026-07-12 |
| **dots.tts** | 4-8GB VRAM, slow TTFA, variable quality. Exceeds 4GB budget. | Mentally abandoned 2026-07-15 |
| **Chatterbox Eng/Mtl** | Same 2GB as Turbo but Turbo is the better variant. | Deprioritized |

### 3.3 Engine Switching Policy

- **Current:** Unload current GPU engine → load new GPU engine. Full warmup cost each switch.
- **Target:** Kokoro always resident (CPU/slim GPU). Chatterbox Turbo never unloaded once loaded. Cloud providers stateless.
- **VRAM constraint:** 4GB total. Kokoro (~500MB) + Chatterbox Turbo (~2GB) = 2.5GB, leaves headroom.

---

## 4. Node.js Layer

### 4.1 server/index.js — Bootstrap

- Fastify instance with 50MB body limit (audio uploads)
- Static mounts: `/web` (dashboard), `/lib` (NUI assets), `/docs`, `/documentation`
- Custom multipart parser: captures raw bytes unchanged, forwards to Python worker (Fastify's default parser would drain the stream)
- Routes registered from `server/api/*.js`

### 4.2 server/engine/manager.js — Engine Resolution

`EngineManager.getEngine(model)` resolution order:

1. **Normalize:** `null`/`undefined`/`"nspeech"` → `currentEngine` (dashboard-selected)
2. **Cloud check:** `resolveCloud(model)` — prefix match against registered adapters
3. **Local check:** `getEntry(model)` — local engine registry lookup
4. **Lazy start:** If local engine not running, spawn `WorkerProcess`

State persistence: `.engine_state.json` stores last-selected engine across restarts.

### 4.3 server/engine/worker.js — Python Process Wrapper

`WorkerProcess` responsibilities:

- **Spawn:** `venv/<engine>/env/Scripts/python -m nspeech.worker_server --engine <name> --port 0`
- **Port discovery:** Poll `%TEMP%/nspeech-<engine>-<pid>.port` (authoritative). Stdout is fallback.
- **Health:** `warming` until model loaded, then `ready`
- **In-flight tracking:** Atomic counter. Engine switch blocked while >0 (returns 409).
- **Crash detection:** Unexpected exit → state=`dead`, 503 to client
- **Stream stall:** Byte-flow watchdog. No bytes for 30s → abort upstream, close client, mark unhealthy.
- **Cancellation:** `AbortController` on every upstream fetch. Client disconnect → abort immediately.
- **Shutdown:** POST `/admin/unload` (free VRAM) → SIGTERM → SIGKILL after 5s grace. Kill process group.

Engine interface methods (same surface as cloud adapters):

```javascript
generatePcmStream({ text, voice_name, speed, instruct_text, extra_body, model })
listVoices()
cloneVoice({ audio, voice_name, prompt_text, model })
previewVoice({ audio, voice_name, prompt_text, preview_text, model })
mixVoices({ name, voice_a, voice_b, ratio })
deleteVoice(voiceId)
health()
stop()
```

### 4.4 server/cloud/registry.js — Cloud Adapter Routing

Prefix matching:

| Prefix | Adapter | Default Model | Example Matches |
|--------|---------|---------------|-----------------|
| `minimax` | MiniMaxAdapter | `speech-2.8-turbo` | `minimax`, `minimax_speech_2_8_hd` |
| `elevenlabs` | ElevenLabsAdapter | `eleven_turbo_v2_5` | `elevenlabs`, `elevenlabs_turbo_v2` |
| `gemini` | GeminiAdapter | `gemini-3.1-flash-tts-preview` | `gemini`, `gemini_3_1_flash_tts` |
| `xai` | XaiAdapter | `grok-tts-1` | `xai`, `xai_grok_tts_1_hd` |

Sub-model normalization: underscores → hyphens, version numbers use dots (`2_8` → `2.8`).

### 4.5 server/transcode.js — PCM to Compressed Audio

`pipePcmToClient(pcmStream, rawResponse, format)`:

1. Spawn ffmpeg with args for target format
2. Pipe PCM chunks into ffmpeg stdin
3. Pipe ffmpeg stdout to HTTP response
4. Handle client disconnect (kill ffmpeg, destroy stream)

Format args:

| Format | Encoder | Bitrate | Container | Notes |
|--------|---------|---------|-----------|-------|
| `mp3` | libmp3lame | 128k | MP3 | ID3 tags suppressed (MediaSource compat) |
| `opus` | libopus | 96k | OGG | 48kHz sample rate |
| `aac` | aac | 128k | ADTS | |
| `wav` | — | — | WAV | Header prepended by worker |
| `pcm` | — | — | Raw | s16le 24kHz mono |
| `pcm_f32` | — | — | Raw | float32 24kHz mono (internal clients) |

### 4.6 server/presets.js — Voice Preset Store

Node-managed JSON files in `presets/<engine>.json`. Presets are engine-scoped.

Preset shape:

```json
{
  "id": "smart-lady",
  "name": "Smart Lady",
  "voice": "Kore",
  "instructions": "Speak in the cadence of a public intellectual.",
  "speed": 0.9,
  "extra_body": {"stability": 0.3}
}
```

API:

- `list(engine)` → array of presets
- `get(engine, id)` → preset or null
- `set(engine, preset)` → create/update
- `remove(engine, id)` → delete
- `lookup(engine, voiceId)` → resolved `{voice, instructions?, speed?, extra_body?}` or null
- `toVoiceList(engine)` → presets mapped to voice list shape

Preset resolution in `speech.js`:
1. Client sends `voice: "smart-lady"`
2. `presets.lookup(engineName, "smart-lady")` returns `{voice: "Kore", instructions: "..."}`
3. `voiceName` replaced with `"Kore"`, `instructions` merged into request

---

## 5. Python Worker Layer

### 5.1 worker_server.py — Entry Point

- Parses `--engine`, `--port`, `--host`
- Sets `NSPEECH_ENGINE` env var before importing `nspeech.config`
- Calls `create_app(engine_name)` from `worker_routes.py`
- Binds to OS-assigned port if `--port 0`
- Writes port to `%TEMP%/nspeech-<engine>-<pid>.port`
- Prints `NSPEECH_WORKER_PORT=<port>` to stdout (fallback)
- Runs uvicorn with `log_level="warning"` (nLogger handles real logging)

### 5.2 worker_routes.py — HTTP Endpoints

Engine-native endpoints (not OpenAI-compatible):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | `{"status": "warming"\|"ready"}` |
| `/v1/voices` | GET | List voices (engine native + directory scan) |
| `/v1/audio/speech` | POST | Generate speech (streams PCM) |
| `/v1/voices/clone` | POST | Persist cloned voice (multipart) |
| `/v1/voices/preview` | POST | Temporary clone + preview audio (multipart) |
| `/v1/voices/mix` | POST | Blend two voices into saved voice |
| `/v1/voices/{voice_id}` | DELETE | Delete voice |
| `/admin/unload` | POST | Release model weights, free VRAM |

**Speech endpoint flow:**

1. Resolve engine via `get_engine(engine_name)`
2. **Blend handling:** If `extra_body.blend` present, compute weighted blend of voice styles, inject as synthetic voice `__blend_<hash>` into `engine.active_voices`
3. **Voice loading:** If not blend, call `engine.load_voice(voice_name)` (with implicit clone from `.wav` if needed)
4. **Build gen_kwargs:** Merge top-level fields + `extra_body` (blend removed after handling)
5. **Generate:** `engine.generate(text, **gen_kwargs)` → yields `(pcm_tensor, is_final)`
6. **Stream or batch:** If `offline` (batch), collect all chunks, return single response. If streaming, yield chunks as they're produced.

**Voice listing flow:**

1. Call `engine.list_voices()` → engine native catalog
2. Scan `venv/<engine>/voices/` directory:
   - `.wav` files with corresponding `.pt` → cloned voices
   - `.pt` files → blended voices
   - `.dots.json` sidecars → dots.tts cloned voices
3. Merge and return

### 5.3 tts.py — Engine Factory

`get_engine(engine_name)`:

- Lazy-loads engine adapter from `src/nspeech/engines/<name>.py`
- `chatterbox-{turbo,eng,mtl}` → `chatterbox.py` with `model_type` argument
- Other engines → direct module import
- Caches adapter in `_engine_cache`

`TTSAdapterProtocol` (structural typing, no base class):

```python
def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]
def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]
def load_voice(self, voice_name: str) -> None
def list_voices(self) -> list
def is_loaded(self) -> bool
def unload(self) -> None
```

### 5.4 Engine Adapters

#### kokoro.py

- ONNX runtime (`kokoro_onnx` package)
- 54 built-in voices via `pipeline.get_voices()`
- Voice styles via `pipeline.get_voice_style(name)` → numpy array
- `active_voices` dict: name → style (numpy array or torch.Tensor)
- Thread-safe: `_voice_lock` protects dict mutations, ONNX `Session.run()` is thread-safe
- `clone()` is a stub: saves `"af_heart"` string as `.pt` file (no real zero-shot cloning)
- `generate()`: sentence-chunks text, resolves voice from `active_voices`, calls `pipeline.create()`

#### chatterbox.py

- Three model variants: `turbo` (350M), `eng` (500M), `mtl` (500M, 23 languages)
- Shared venv, separate voice directories
- Voice cache: `voices/<name>.pt` (conditionals extracted by this model only)
- `clone()`: `model.prepare_conditionals(audio_path, exaggeration=...)` → `model.conds.save(cache_path)`
- `generate()`: accepts `expressiveness` (API standard) or `exaggeration` (legacy), maps to `exaggeration` param
- `turbo` variant: ignores `exaggeration`, uses `audio_prompt_path=""` (paralinguistic tags via text)

#### dots.py

- 2B parameter AR model (Qwen2.5-1.5B backbone + flow-matching DiT + 48kHz AudioVAE)
- Checkpoints: `mf` (4 NFE, MeanFlow distilled, default), `soar` (10-32 NFE, better quality), `base`
- Voice cache: `{name}.wav` + `{name}.dots.json` (sidecar with path + prompt_text)
- `generate()`: streaming yields patches at 48kHz, resampled to 24kHz per patch
- `inference_steps` parameter: accepts `inference_steps` (standard), falls back to `steps`/`num_steps`
- Known issue: first-chunk transient (FIR filter edge effect), fix attempted but rolled back

---

## 6. API Surface

### 6.1 Client-Facing Endpoints

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/v1/audio/speech` | POST | Generate speech | None (local) |
| `/v1/voices` | GET | List voices | None |
| `/v1/audio/transcriptions` | POST | Speech-to-text (via nVoice) | None |
| `/health` | GET | Node server health | None |

### 6.2 Admin Endpoints (Dashboard)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/voices/clone` | POST | Create cloned voice from reference audio |
| `/v1/voices/preview` | POST | Temporary clone + preview |
| `/v1/voices/mix` | POST | Create blended voice |
| `/v1/voices/preset` | POST | Create voice preset |
| `/v1/voices/{voice_id}` | DELETE | Delete voice or preset |
| `/v1/admin/engine` | POST | Switch engine (SSE stream) |
| `/v1/admin/status` | GET | Engine manager status |

### 6.3 Voice Categories (Client View)

Clients see a flat list with three categories:

| Category | Source | Examples |
|----------|--------|----------|
| `native` | Engine built-in voices | Kokoro's 54, Gemini's 30, MiniMax's 332 |
| `cloned` | Created via dashboard from reference audio | User-cloned voices |
| `preset` | Saved voice configuration (voice + instructions + settings) | "Smart Lady", "Stern Narrator" |

**Note:** "Blended" voices (created via `/v1/voices/mix`) appear as `cloned` in the voice list. The client doesn't distinguish creation method.

---

## 7. Request/Response Schemas

### 7.1 POST /v1/audio/speech

**Request:**

```json
{
  "model": "nspeech",
  "input": "Hello world.",
  "voice": "af_heart",
  "response_format": "mp3",
  "speed": 1.0,
  "instructions": "Speak clearly and warmly.",
  "extra_body": {
    "pitch": 0,
    "emotion": "happy",
    "expressiveness": 0.7,
    "stability": 0.5,
    "inference_steps": 4,
    "guidance_scale": 1.2,
    "seed": 42,
    "batch": false,
    "model": "speech-2.8-turbo",
    "blend": [{"voice_id": "af_heart", "weight": 30}, {"voice_id": "af_bella", "weight": 70}],
    "pronunciation": {"tone": ["omg/oh my god"]},
    "ssml": false,
    "language": "en",
    "sample_rate": 24000,
    "channel": 1,
    "bitrate": 128000,
    "sound_effects": null
  }
}
```

**Standard OpenAI fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | ✅ | Engine selector. `"nspeech"` (dashboard-selected), `"minimax"`, `"elevenlabs"`, `"gemini"`, `"xai"`, or local engine name. |
| `input` | string | ✅ | Text to speak. |
| `voice` | string | — | Voice ID. May be native, cloned, or preset. |
| `response_format` | string | — | `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm`, `pcm_f32` |
| `speed` | float | — | Speaking speed. OpenAI range 0.25–4.0. Engines may clamp. |
| `instructions` | string | — | Natural-language style direction. Passed through when supported. |

**extra_body fields (all optional):**

| Category | Field | Type | Range | Description |
|----------|-------|------|-------|-------------|
| Voice Character | `pitch` | number | -12..12 | Semitone pitch shift |
| Voice Character | `emotion` | string | enum | `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `calm`, `whisper`, `fluent` |
| Voice Character | `expressiveness` | number | 0..1 | Delivery intensity (0=flat, 1=dramatic) |
| Voice Character | `stability` | number | 0..1 | Voice consistency (0=variable, 1=steady) |
| Quality | `inference_steps` | int | 1..32 | Diffusion/flow NFE |
| Quality | `guidance_scale` | number | 0..3 | Voice reference adherence |
| Quality | `seed` | int | any | Random seed for reproducibility |
| Quality | `batch` | boolean | — | `true`=render full audio first, `false`=stream progressively |
| Model Selection | `model` | string | — | Provider sub-model override |
| Voice Blending | `blend` | array | — | Up to 4 `{voice_id, weight}` pairs. Overrides top-level `voice`. |
| Text Processing | `pronunciation` | object | — | `{tone: ["original/replacement"]}` |
| Text Processing | `ssml` | boolean | — | Interpret `input` as SSML |
| Text Processing | `language` | string | — | ISO-639-1 hint, `auto` for detection |
| Audio Output | `sample_rate` | int | 8000..44100 | Output sample rate |
| Audio Output | `channel` | int | 1, 2 | Mono or stereo |
| Audio Output | `bitrate` | int | — | Compressed audio bitrate |
| Effects | `sound_effects` | string | — | Provider-specific effect |

**Field Support Matrix:**

| Field | Kokoro | Chatterbox | dots.tts | MiniMax | ElevenLabs | Gemini | xAI |
|-------|--------|------------|----------|---------|------------|--------|-----|
| `pitch` | — | — | — | ✅ | — | — | — |
| `emotion` | — | — | — | ✅ | — | ✅ (maps to tags) | — |
| `expressiveness` | — | ✅ (→exaggeration) | — | ⚠️ (→emotion if >0.7) | ✅ (→style) | — | ✅ |
| `stability` | — | — | — | — | ✅ | — | — |
| `inference_steps` | — | — | ✅ | — | — | — | — |
| `guidance_scale` | — | — | ✅ | — | ✅ (→similarity_boost) | — | — |
| `seed` | — | — | ✅ | — | ✅ | — | — |
| `batch` | — | ✅ | ✅ | — | — | — | — |
| `blend` | ✅ (per-request) | — | — | ✅ (timbre_weights) | — | — | — |
| `language` | — | ✅ (mtl) | — | ✅ | ✅ | ✅ (auto) | ✅ |
| `sample_rate` | — | — | — | ✅ | — | — | ✅ |
| `bitrate` | — | — | — | ✅ | — | — | ✅ |
| `sound_effects` | — | — | — | ✅ | — | — | — |

**Response:**

Streaming audio in requested format. Headers:

- `Content-Type`: `audio/mpeg`, `audio/ogg`, `audio/aac`, `audio/wav`, etc.
- `X-Stream-Mode`: `native` (real incremental) or `chunked` (complete file sliced)

**Error shape:**

```json
{
  "error": {
    "message": "Voice not found: unknown_voice",
    "type": "invalid_request_error",
    "code": "voice_not_found",
    "param": "voice"
  }
}
```

Error types: `invalid_request_error`, `engine_error`, `rate_limit_exceeded`, `service_unavailable`

### 7.2 GET /v1/voices

**Query params:** `?engine=<name>` (optional, defaults to current engine)

**Response:**

```json
{
  "voices": [
    {"voice_id": "af_heart", "name": "af_heart", "category": "builtin", "voice_type": "builtin", "engine": "kokoro"},
    {"voice_id": "my_clone", "name": "my_clone", "category": "cloned", "voice_type": "cloned", "engine": "kokoro"},
    {"voice_id": "smart-lady", "name": "Smart Lady", "category": "preset", "voice_type": "preset", "engine": "gemini", "base_voice": "Kore", "instructions": "Speak in the cadence of a public intellectual."}
  ]
}
```

### 7.3 POST /v1/voices/clone (Admin)

Multipart form data:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `audio` | file | ✅ | Reference audio (WAV, MP3) |
| `name` | string | ✅ | Voice ID (URL-safe) |
| `model` | string | — | Sub-model override |
| `prompt_text` | string | — | Transcript of reference audio (dots.tts) |
| `exaggeration` | float | — | Clone expressiveness (Chatterbox) |

**Response:**

```json
{
  "voice_name": "my_voice",
  "engine": "chatterbox-turbo",
  "cache_file": "venv/chatterbox-turbo/voices/my_voice.pt",
  "clone_time_ms": 1250
}
```

### 7.4 POST /v1/voices/mix (Admin)

**Request:**

```json
{
  "name": "my_blend",
  "voice_a": "af_heart",
  "voice_b": "af_bella",
  "ratio": 0.7
}
```

**Response:**

```json
{
  "voice_id": "my_blend",
  "name": "my_blend",
  "category": "blended",
  "engine": "kokoro",
  "cache_file": "venv/kokoro/voices/my_blend.kokoro.pt"
}
```

### 7.5 POST /v1/voices/preset (Admin)

**Request:**

```json
{
  "engine": "gemini",
  "id": "smart-lady",
  "name": "Smart Lady",
  "voice": "Kore",
  "instructions": "Speak in the cadence of a public intellectual.",
  "speed": 0.9,
  "extra_body": {"stability": 0.3}
}
```

### 7.6 POST /v1/admin/engine (Admin)

**Request:**

```json
{"engine": "chatterbox-turbo"}
```

**Response:** SSE stream

```
data: {"stage": "unload_start", "engine": "kokoro"}
data: {"stage": "unload_done", "engine": "kokoro"}
data: {"stage": "load_start", "engine": "chatterbox-turbo"}
data: {"stage": "load_done", "engine": "chatterbox-turbo"}
data: {"stage": "complete", "engine": "chatterbox-turbo"}
```

---

## 8. Data Flow

### 8.1 Streaming TTS Request (Local Engine)

```
Client → Node:POST /v1/audio/speech {model:"kokoro", input:"Hello", voice:"af_heart", response_format:"mp3"}
  Node:speech.js — validate, resolve engine (kokoro worker), resolve preset
  Node:worker.js — generatePcmStream({text, voice_name, speed, extra_body})
    Worker:worker_routes.py — load voice, merge extra_body, engine.generate()
      Python:kokoro.py — sentence chunking, pipeline.create() per sentence
      Python → Worker: yield (pcm_tensor, is_final)
    Worker → Node: HTTP stream of PCM chunks (s16le 24kHz mono)
  Node:transcode.js — spawn ffmpeg, pipe PCM → MP3
  Node → Client: HTTP stream of MP3 chunks
```

### 8.2 Streaming TTS Request (Cloud Engine)

```
Client → Node:POST /v1/audio/speech {model:"minimax", input:"Hello", voice:"English_expressive_narrator"}
  Node:speech.js — resolve engine (MiniMaxAdapter), resolve preset
  Node:minimax.js — generatePcmStream({text, voice_name, extra_body})
    Adapter: map extra_body to MiniMax params, POST to MiniMax API
    Adapter: parse SSE hex → PCM chunks
    Adapter → Node: Readable stream of PCM chunks
  Node:transcode.js — spawn ffmpeg, pipe PCM → MP3
  Node → Client: HTTP stream of MP3 chunks
```

### 8.3 Per-Request Blend (Kokoro)

```
Client → Node:POST /v1/audio/speech {model:"kokoro", input:"Hello", extra_body:{blend:[{voice_id:"af_heart",weight:30},{voice_id:"af_bella",weight:70}]}}
  Node:speech.js — resolve engine
  Node:worker.js — generatePcmStream({extra_body: {blend: [...]}})
    Worker:worker_routes.py — detect blend in extra_body
      Python: compute weighted blend of af_heart (30%) + af_bella (70%)
      Python: inject as synthetic voice "__blend_a1b2c3d4e5f6" into active_voices
      Python: generate() uses synthetic voice
    Worker → Node: PCM stream
  Node → Client: transcoded audio
```

---

## 9. Configuration

### 9.1 config.json

```json
{
  "host": "127.0.0.1",
  "port": 8000,
  "default_engine": "kokoro",
  "nvoice_url": "https://192.168.0.100:2244",
  "voice_dir": "venv/{engine}/voices",
  "model_dir": "venv/{engine}/models",
  "log_level": "INFO"
}
```

Port overridden by `NSPEECH_PORT` in `.env`.

### 9.2 .env

```bash
NSPEECH_PORT=2233
NSPEECH_ENGINE=kokoro
MINIMAX_API_KEY=...
ELEVENLABS_API_KEY=...
XAI_API_KEY=...
GEMINI_API_KEY=...
```

**`.env` is in `.gitignore` — NEVER committed.**

### 9.3 Per-Engine Environment (set by Node on spawn)

| Variable | Value | Purpose |
|----------|-------|---------|
| `NSPEECH_ENGINE` | `kokoro` | Engine name |
| `NSPEECH_VOICE_DIR` | `venv/kokoro/voices` | Voice cache directory |
| `NSPEECH_MODEL_DIR` | `venv/kokoro/models` | Model weights directory |
| `PYTHONPATH` | `src/` | Python module path |

---

## 10. File System Layout

```
nSpeech/
├── server/                 # Node.js API server
│   ├── index.js            # Fastify bootstrap
│   ├── config.js           # config.json + .env loader
│   ├── transcode.js        # ffmpeg PCM→MP3/Opus/AAC relay
│   ├── logger.js           # nLogger adapter
│   ├── presets.js          # Voice preset store
│   ├── events.js           # SSE event bus
│   ├── api/
│   │   ├── speech.js       # POST /v1/audio/speech
│   │   ├── voices.js       # GET|POST|DELETE /v1/voices/*
│   │   ├── admin.js        # POST /v1/admin/engine
│   │   ├── formats.js      # Format normalization
│   │   ├── multipart.js    # Multipart parser (raw buffer)
│   │   ├── speech-clone.js # POST /v1/audio/speech/clone
│   │   └── transcriptions.js # POST /v1/audio/transcriptions
│   ├── engine/
│   │   ├── manager.js      # EngineManager
│   │   ├── worker.js       # WorkerProcess
│   │   ├── registry.js     # Local engine registry
│   │   └── registry.json   # Engine metadata (venv path, GPU flag)
│   └── cloud/
│       ├── registry.js     # Cloud adapter routing
│       ├── minimax.js
│       ├── elevenlabs.js
│       ├── gemini.js
│       └── xai.js
├── src/nspeech/            # Python engine layer
│   ├── __init__.py
│   ├── config.py           # Env var config
│   ├── logger.py           # nLogger Python adapter
│   ├── tts.py              # Engine factory + protocol
│   ├── worker_routes.py    # FastAPI endpoints
│   ├── worker_server.py    # uvicorn entry point
│   ├── audio_formats.py    # PCM/WAV utilities
│   ├── transcribe.py       # STT via nVoice
│   └── engines/
│       ├── kokoro.py
│       ├── chatterbox.py
│       └── dots.py
├── web/                    # NUI dashboard (admin UI)
│   ├── index.html
│   ├── js/app.js           # Engine-aware navigation
│   ├── css/main.css
│   └── pages/              # Per-engine pages
│       ├── home.html
│       ├── docs.html
│       ├── kokoro/
│       ├── chatterbox-turbo/
│       ├── chatterbox-eng/
│       ├── chatterbox-mtl/
│       ├── dots/
│       ├── minimax/
│       ├── elevenlabs/
│       ├── gemini/
│       └── xai/
├── presets/                # Voice presets (Node-managed)
│   ├── gemini.json
│   └── xai.json
├── venv/                   # Per-engine Python environments
│   ├── kokoro/
│   │   ├── env/            # Python venv
│   │   ├── voices/         # Voice caches
│   │   └── models/         # Model weights
│   ├── chatterbox/         # Shared venv for all CB variants
│   │   ├── env/
│   │   └── voices/         # Actually per-variant subdirs
│   ├── chatterbox-turbo/
│   │   └── voices/
│   ├── chatterbox-eng/
│   │   └── voices/
│   ├── chatterbox-mtl/
│   │   └── voices/
│   └── dots/
│       ├── env/
│       ├── voices/
│       └── models/
├── lib/                    # Git submodules
│   ├── nui_wc2/            # NUI Web Components
│   ├── nlogger/            # Unified logging
│   └── nvideo/             # Bundled ffmpeg
├── docs/                   # Working documents
│   ├── AUDIO_API_PLAN.md   # Canonical API contract
│   ├── AUDIO_API_DEV_PLAN.md
│   ├── VOICE_PRESETS.md
│   ├── handover_*.md
│   └── providers/          # Provider API docs
├── documentation/
│   └── API_REFERENCE.md    # Concise API reference
├── requirements/           # Per-engine dependency lists
│   ├── core.txt
│   ├── kokoro.txt
│   ├── chatterbox.txt
│   └── dots.txt
├── voices_samples/         # Reference audio for testing
├── logs/                   # Log files
├── install.py              # Per-engine venv installer
├── package.json
├── config.json
└── .env                    # Secrets (gitignored)
```

---

## 11. Known Limitations & Technical Debt

| Issue | Severity | Status | Notes |
|-------|----------|--------|-------|
| Kokoro `clone()` is a stub | Medium | Accepted | ONNX model lacks style-extractor network. Saves `"af_heart"` string. |
| Chatterbox `turbo` ignores `exaggeration` | Low | By design | Turbo model uses `audio_prompt_path=""` instead. Paralinguistic tags via text. |
| dots.tts first-chunk transient | Low | Rolled back | FIR filter edge effect. Fix attempted but caused dimension mismatch. |
| dots.tts `soar` checkpoint tensor shapes | Low | Unresolved | Returns `(1, 1, samples)` instead of `(1, samples)`. Needs `flatten()` handling. |
| MiniMax `expressiveness` mapping is crude | Low | Accepted | Maps to `emotion` if >0.7. No real expressiveness control in MiniMax API. |
| Engine switch latency | Medium | Accepted | Unload → load cycle. Could be improved with pinned memory or predictive warming. |
| xAI no true streaming | Low | By design | Unary HTTP endpoint returns full audio. WS streaming available but not implemented. |

---

## 12. Development Workflow

### Setup

```bash
# Install Node dependencies
npm install

# Install Python engine (kokoro default)
python install.py install

# Or install all engines + models
python install.py install --engine all --models

# Configure
cp .env.example .env
# Edit .env with API keys

# Run
npm start
# Dashboard at http://127.0.0.1:2233/
```

### Adding a New Engine

1. Create `src/nspeech/engines/<name>.py` implementing `TTSAdapterProtocol`
2. Add entry to `server/engine/registry.json` with venv path, GPU flag
3. Add to `src/nspeech/tts.py` factory if special resolution needed
4. Create `requirements/<name>.txt`
5. Add install logic to `install.py`
6. Create dashboard pages at `web/pages/<name>/`
7. Add to `web/js/app.js` ENGINES map

### Testing

```bash
# Health check
curl http://127.0.0.1:2233/health

# List voices
curl http://127.0.0.1:2233/v1/voices?engine=kokoro

# Generate speech
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","input":"Hello world.","voice":"af_heart","response_format":"mp3"}' \
  --output test.mp3

# Engine switch
curl -N -X POST http://127.0.0.1:2233/v1/admin/engine \
  -H "Content-Type: application/json" \
  -d '{"engine":"chatterbox-turbo"}'
```

---

## 13. Session Log (2026-07-17)

**Changes made:**

1. **Chatterbox `expressiveness` support:** Adapter now reads `expressiveness` (API standard) with fallback to `exaggeration` (legacy) in both `clone()` and `generate()`.

2. **Per-request blend for Kokoro:** `worker_routes.py` speech endpoint now detects `extra_body.blend`, computes weighted blend of voice styles, injects as synthetic voice `__blend_<hash>` into `engine.active_voices`. Client can blend up to 4 voices per request without saving anything.

3. **Voice name explicit in gen_kwargs:** Added `voice_name=req.voice_name` to `gen_kwargs` so blend synthetic names reach `generate()`. Previously relied on mutable `current_voice` state.

**Files modified:**

- `src/nspeech/engines/chatterbox.py` — expressiveness/exaggeration dual-read
- `src/nspeech/worker_routes.py` — blend handling, explicit voice_name in gen_kwargs

**Pending:**

- `server/engine/worker.js` — remove redundant `expressiveness`→`exaggeration` top-level mapping (adapter now handles it)
- Verify `inference_steps` works for all engines that support it (dots.tts confirmed, others N/A)
- Test per-request blend end-to-end

---

*Last updated: 2026-07-17*
