# nSpeech Service Specification

## 1. Overview

nSpeech is a self-hosted text-to-speech service with a pluggable engine architecture.
Each TTS backend runs in an isolated Python virtual environment, eliminating dependency
conflicts between engines (e.g., CosyVoice requires transformers 4.51.3, while others
use 5.x).

Key features:

- **Engine-agnostic architecture** — pluggable TTS adapters; same API regardless of backend
- **Per-engine isolation** — separate venvs, model dirs, and voice caches per engine
- **Zero-shot voice cloning** from a short reference audio clip (engine-dependent)
- **Voice blending** — mix two Kokoro voices algorithmically (Kokoro only)
- **Voice caching** — cloned/blended voices persist as `.pt` files per engine
- **Automatic text chunking** — long input is split into sentence-level chunks
- **Streaming** — audio chunks emitted as they are generated via HTTP and WebSocket
- **On-the-fly transcoding** — PCM to MP3/Opus/AAC via PyAV
- **Low latency** — first audio byte in ~400-700 ms (Kokoro CPU)

The service exposes HTTP REST and WebSocket endpoints. Callers send text and receive
audio. The underlying TTS engine is an implementation detail.

---

## 2. Goals

- Provide a technology-agnostic TTS service surface — swap engines via adapters
- Synthesize natural speech from arbitrary text in <1 s to first byte
- Clone voices from reference audio in <2 s (where engine supports it)
- Stream audio chunks as they are generated
- Handle long text automatically via sentence-level chunking
- Run on CPU or consumer GPU depending on engine
- Provide a clean HTTP/WebSocket API for integration by any caller
- Output browser-native formats (MP3, Opus, WAV, PCM)

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  nSpeech Service                                            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  HTTP / WebSocket API  (FastAPI + uvicorn)          │   │
│  │                                                     │   │
│  │  GET  /              — Dashboard UI                 │   │
│  │  POST /tts           — streaming synthesis          │   │
│  │  GET  /tts           — HTML <audio> proxy           │   │
│  │  POST /v1/audio/speech — OpenAI compatible          │   │
│  │  POST /voices/clone  — clone voice from audio       │   │
│  │  POST /voices/mix    — blend two voices (Kokoro)    │   │
│  │  GET  /voices        — list available voices        │   │
│  │  GET  /health        — health + engine status       │   │
│  │  WS   /ws/tts        — streaming synthesis          │   │
│  └─────────────────────────────────────────────────────┘   │
│                        │                                    │
│                        ▼                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  TTS Adapter Layer (duck-typed, no base class)      │   │
│  │  • Normalized voice cache format per engine         │   │
│  │  • Sentence-level chunking                          │   │
│  │  • PCM chunk streaming                              │   │
│  │  • Contract: generate(), clone(), load_voice()      │   │
│  └─────────────────────────────────────────────────────┘   │
│                        │                                    │
│            ┌───────────┼───────────┬───────────┐           │
│            ▼           ▼           ▼           ▼           │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────┐  │
│  │ Kokoro          │ │ Chatterbox      │ │ CosyVoice   │  │
│  │ (default)       │ │ (archived)      │ │ (partial)   │  │
│  │ ~6 MB RAM       │ │ ~3.8 GB VRAM    │ │ TBD         │  │
│  │ 54 built-in     │ │ zero-shot clone │ │             │  │
│  │ voice mixing    │ │                 │ │             │  │
│  └─────────────────┘ └─────────────────┘ └─────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Transcoding Layer (PyAV, on-demand)                │   │
│  │  • PCM → MP3 / Opus / AAC / WAV                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Web Dashboard (NUI — vanilla Web Components)       │   │
│  │  • Engine-centric navigation (Generate + Voices)    │   │
│  │  • Router-based SPA, no build step                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Component Responsibilities

| Component | Technology | Role |
|-----------|-----------|------|
| **API** | FastAPI + uvicorn | HTTP / WebSocket endpoints, request routing |
| **Adapter** | Duck-typed Python | Chunking, streaming, voice cache management |
| **TTS Engine** | Kokoro (default) | Ultra-low latency CPU, 54 voices, voice mixing |
| **TTS Engine** | Chatterbox (archived) | ~3.8 GB VRAM, true zero-shot cloning |
| **TTS Engine** | CosyVoice (partial) | Multilingual evaluation in progress |
| **Transcoder** | PyAV | PCM → MP3/Opus/AAC on demand |
| **Dashboard** | NUI (Web Components) | Browser UI for generation and voice management |

### 3.2 Concurrency

GPU VRAM is a constrained resource. The core inference pipeline is gated by a global
asynchronous lock (`asyncio.Lock()`). Multiple callers connecting simultaneously have
their chunks queued FIFO style. Streaming allows multiplexing at the sentence level.

Kokoro runs entirely on CPU and does not require GPU locking.

### 3.3 Text Chunking

The adapter splits text by sentence punctuation (`(?<=[.!?])\s+`). If a request provides
an abnormally long string without punctuation, the adapter falls back to the raw text
as a single chunk (the engine handles its own limits).

---

## 4. Configuration

All configuration is explicit via environment variables or `.env` file. Missing required
values fail fast at startup.

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `NSPEECH_ENGINE` | TTS adapter backend: `kokoro`, `chatterbox`, `cosyvoice` | Yes | — |
| `NSPEECH_HOST` | IP to bind the HTTP/WS socket | No | `127.0.0.1` |
| `NSPEECH_PORT` | Port for the service | No | `8000` |
| `NSPEECH_VOICE_DIR` | Directory for voice caches and reference audio | Yes | — |
| `NSPEECH_MODEL_DIR` | Directory for engine model weights | Yes | — |
| `NSPEECH_API_KEY` | Bearer token for auth. Empty = open access. | No | `""` |
| `NSPEECH_PRELOAD_MODEL` | Load model immediately on startup | No | `false` |
| `NSPEECH_MODEL_IDLE_TIMEOUT_SEC` | Seconds before evicting idle model. `0` = never. | No | `0` |
| `NSPEECH_LOG_LEVEL` | Logging verbosity | No | `INFO` |

Per-engine directories:
- `venv/<engine>/env/` — Python virtual environment
- `venv/<engine>/models/` — Engine model weights
- `venv/<engine>/voices/` — Voice caches and reference audio

---

## 5. Generation Flow

### 5.1 Streaming (HTTP POST /tts)

```
Caller POST /tts
  {
    "text": "Turning on the lights.",
    "voice_name": "af_heart",
    "output_format": "mp3"
  }

   0 ms  Receive request
  50 ms  Load voice cache (if not already loaded)
 400 ms  Chunk 1 PCM generated (Kokoro CPU)
 410 ms  Transcode to MP3
 420 ms  First bytes streamed to client
  ...   Continue until complete
```

### 5.2 Single-Shot (GET /tts)

A proxy around POST `/tts` for native HTML `<audio src="...">` streaming:

```
GET /tts?text=Hello&voice_name=af_heart&output_format=mp3
```

Returns the same chunked audio stream with appropriate Content-Type.

### 5.3 WebSocket Streaming (/ws/tts)

```
Caller WS /ws/tts
  {
    "text": "Here are today's headlines. First, the weather...",
    "voice_name": "af_heart",
    "output_format": "mp3",
    "exaggeration": 0.5
  }

   0 ms  Receive request
  50 ms  Load voice cache
 400 ms  Binary frame: encoded audio chunk 1
 700 ms  Binary frame: encoded audio chunk 2
 750 ms  Text frame: {"is_final": true}
```

### 5.4 Voice Cloning

```
Caller POST /voices/clone
  multipart: file=reference.wav, name="my_voice"

   0 ms  Receive reference audio
  50 ms  Save .wav to voices dir
 500 ms  Extract embedding (Chatterbox) or stub (Kokoro)
1200 ms  Save cache: venv/<engine>/voices/my_voice.<engine>.pt
1250 ms  Response: {voice_name: "my_voice", ...}
```

**Engine differences:**
- **Chatterbox**: True zero-shot cloning — extracts embeddings from `.wav`
- **Kokoro**: Stubbed — saves a fallback voice reference since the ONNX package
  lacks the style-extractor network. Clone requests should route to Chatterbox
  if true zero-shot is required.

### 5.5 Voice Mixing (Kokoro only)

```
POST /voices/mix
  {
    "name": "my_blend",
    "voice_a": "af_heart",
    "voice_b": "am_michael",
    "ratio": 0.5
  }
```

Blends two Kokoro voice style tensors and saves as a new `.pt` cache file.

---

## 6. Output Formats

| Format | Container | Codec | Content-Type | Best For |
|--------|-----------|-------|-------------|----------|
| `pcm` | None | Raw PCM | `application/octet-stream` | WebSocket, local clients |
| `wav` | RIFF | PCM | `audio/wav` | Compatibility, single-shot |
| `mp3` | None | MP3 | `audio/mpeg` | Universal browser support |
| `ogg` | Ogg | Opus | `audio/ogg` | Streaming, good compression |
| `webm` | WebM | Opus | `audio/webm` | Browser streaming |

**Default:** `mp3` for HTTP, `mp3` for WebSocket.

**WAV streaming:** A streaming WAV header (44 bytes, unknown length) is prepended
for `output_format: "wav"`, allowing progressive playback.

---

## 7. API

If `NSPEECH_API_KEY` is configured, all HTTP endpoints must provide:
`Authorization: Bearer <token>`

For WebSockets, auth can be passed as a query parameter `?token=<token>`.

### 7.1 HTTP Errors

| Status | Meaning |
|--------|---------|
| `400` | Missing parameters, unsupported format, invalid voice name |
| `401` | Missing or invalid API key |
| `404` | Voice not found |
| `422` | Corrupt audio file for cloning |
| `500` | Generation failed internally |
| `503` | Unable to load model, GPU exhausted |

Error responses return JSON: `{"error": "CODE", "message": "..."}`

### 7.2 HTTP Endpoints

#### `POST /tts`
Streaming synthesis. Returns chunked audio.

```json
{
  "text": "Turning on the lights.",
  "voice_name": "af_heart",
  "engine": "kokoro",
  "exaggeration": 0.5,
  "output_format": "mp3",
  "transcode_bitrate": "128k",
  "transcode_sample_rate": 24000
}
```

#### `GET /tts`
Same as POST but with query parameters for `<audio src="...">` compatibility.

#### `POST /v1/audio/speech` (OpenAI Compatible)
Drop-in replacement for OpenAI TTS API.

```json
{
  "model": "kokoro",
  "input": "Turning on the lights.",
  "voice": "af_heart",
  "response_format": "mp3",
  "speed": 1.0
}
```

- `model` → `engine`
- `input` → `text`
- `voice` → `voice_name`
- `response_format` → `output_format` (mp3, opus, aac, flac, wav, pcm)
- `speed` → `exaggeration` (inverted mapping)

#### `POST /voices/clone`
Accepts a reference audio clip and triggers the engine to compute its embedding.
Caches are saved with an engine-specific extension: `<name>.<engine>.pt`.

```
Form data:
  file: <reference audio (.wav)>
  name: "my_voice"
  engine: "kokoro"      (optional, defaults to NSPEECH_ENGINE)
  exaggeration: 0.5     (optional)
```

Response (engine-dependent):
```json
{
  "voice_name": "my_voice",
  "engine": "chatterbox",
  "cache_file": "voices/my_voice.chatterbox.pt",
  "source_file": "voices/my_voice.wav",
  "file_size_bytes": 101127,
  "clone_time_ms": 1250
}
```

#### `POST /voices/mix`
Blend two Kokoro voices algorithmically.

```json
{
  "name": "my_blend",
  "voice_a": "af_heart",
  "voice_b": "am_michael",
  "ratio": 0.5
}
```

Returns `{"voice_name", "cache_file", "voice_a", "voice_b", "ratio"}`.
Returns 400 if current engine does not support voice blending.

#### `GET /voices`
Lists all available voices.

Response:
```json
{
  "voices": [
    {
      "name": "af_heart",
      "source_file": "builtin",
      "voice_type": "builtin",
      "engines": [{"name": "kokoro", "cached": true, "latency_tier": "fast"}]
    },
    {
      "name": "my_voice",
      "source_file": "my_voice.wav",
      "voice_type": "cloned",
      "engines": [{"name": "chatterbox", "cached": true}]
    },
    {
      "name": "my_blend",
      "source_file": "my_blend.kokoro.pt",
      "voice_type": "blended",
      "engines": [{"name": "kokoro", "cached": true}]
    }
  ]
}
```

Voice types:
- `builtin` — Engine-native voices (Kokoro's 54 built-in voices)
- `cloned` — Created from uploaded `.wav` via `/voices/clone`
- `blended` — Created via `/voices/mix` (Kokoro only)

#### `GET /health`

```json
{
  "status": "ok",
  "default_engine": "kokoro"
}
```

### 7.3 WebSocket (`/ws/tts`)

**Client → Server:**

```json
{
  "type": "tts_stream",
  "text": "Turning on the lights.",
  "voice_name": "af_heart",
  "engine": "kokoro",
  "exaggeration": 0.5,
  "output_format": "mp3",
  "transcode_bitrate": "128k",
  "transcode_sample_rate": 24000
}
```

**Server → Client:**

Binary frames containing encoded audio chunks, followed by:
```json
{"is_final": true}
```

On error:
```json
{"error": "MODEL_NOT_LOADED", "message": "..."}
```

---

## 8. Engine Lifecycle

```
┌─────────────┐
│    IDLE     │  Server running, model not loaded
└──────┬──────┘
       │ request received
       ▼
┌─────────────┐
│  LOADING    │  Lazy load adapter on first request
└──────┬──────┘
       │ adapter ready
       ▼
┌─────────────┐
│  GENERATING │  Synthesize audio (streaming)
└──────┬──────┘
       │ done / connection closed
       ▼
┌─────────────┐
│    IDLE     │  Keep model loaded (LRU eviction if timeout > 0)
└─────────────┘
```

Engines are loaded lazily on first request. If `NSPEECH_MODEL_IDLE_TIMEOUT_SEC > 0`,
an idle engine is evicted from memory after the timeout expires.

---

## 9. Resource Usage

| Engine | RAM | VRAM | Load Time |
|--------|-----|------|-----------|
| Kokoro | ~6 MB | 0 (CPU) | <1 s |
| Chatterbox | ~500 MB | ~3.8 GB | ~5-10 s |
| CosyVoice | TBD | TBD | TBD |

---

## 10. Performance

| Metric | Target | Actual (Kokoro CPU) |
|--------|--------|---------------------|
| First audio byte | <1000 ms | ~400-700 ms |
| Full generation (20 words) | <1500 ms | ~1000 ms |
| Voice cache load | <10 ms | Instant |
| Model cold start | <5000 ms | <1 s |

---

## 11. Adapter Interface

Adapters are plain Python classes placed in `src/nspeech/engines/<engine_name>.py`.
The class name should be `<EngineName>Adapter` (e.g., `KokoroAdapter`).
No base class or inheritance hierarchy is used — duck typing via `TTSAdapterProtocol`.

```python
import torch
from typing import Iterator, Tuple, Dict, Any

class MyEngineAdapter:
    def __init__(self):
        # Light initialization. Do NOT load weights here.
        self.engine_name = "myengine"

    def generate(self, text: str, **kwargs) -> Iterator[Tuple[torch.Tensor, bool]]:
        """
        Sentence-level chunking, yields (pcm_tensor, is_final).
        pcm_tensor: flat torch.Tensor of float32 PCM at 24kHz mono.
        """
        ...

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]:
        """
        Compute engine-specific embedding from reference .wav.
        Save to <voice_dir>/<voice_name>.<engine_name>.pt
        Returns metadata dict.
        """
        ...

    def load_voice(self, voice_name: str) -> None:
        """
        Load cached voice embedding. Fail fast if cache missing.
        """
        ...
```

---

## 12. Technology

| Layer | Technology | Notes |
|-------|-----------|-------|
| Python | CPython 3.13+ | |
| PyTorch | Per-engine | CPU for Kokoro, CUDA for Chatterbox/CosyVoice |
| TTS Engine | kokoro-onnx | Default. Ultra-fast CPU, 54 voices |
| TTS Engine | chatterbox-tts | Archived. True zero-shot cloning |
| TTS Engine | CosyVoice | Evaluation in progress |
| Transcoding | PyAV | On-the-fly MP3/Opus/AAC encoding |
| Server | FastAPI + uvicorn | HTTP REST + WebSocket |
| Audio I/O | soundfile | WAV read/write |
| Dashboard | NUI | Vanilla Web Components, zero build step |

---

## 13. Installation

Per-engine installation:

```bash
# Kokoro (CPU, fast, English)
python install.py install --engine kokoro --models

# Chatterbox (GPU, cloning)
python install.py install --engine chatterbox --models

# CosyVoice (multilingual, evaluation)
python install.py install --engine cosyvoice
```

Other commands:
```bash
python install.py verify --engine kokoro    # Check installation
python install.py update --engine kokoro    # Update packages
python install.py models --engine kokoro    # Download weights only
python benchmark.py                          # Run TTS benchmarks
```

Set `.env` before running:
```
NSPEECH_ENGINE=kokoro
NSPEECH_VOICE_DIR=venv/kokoro/voices
NSPEECH_MODEL_DIR=venv/kokoro/models
```

---

## 14. Project Structure

```
nSpeech/
├── .env                    # Service configuration
├── .env.example            # Configuration template
├── install.py              # Per-engine installer
├── run.py                  # Server launcher (auto-detects venv)
├── benchmark.py            # TTS benchmark (auto-detects venv)
├── requirements/           # Per-engine dependency lists
│   ├── core.txt            # FastAPI, soundfile, numpy, etc.
│   ├── kokoro.txt          # kokoro-onnx
│   ├── chatterbox.txt      # chatterbox-tts + deps
│   └── cosyvoice.txt       # CosyVoice deps
├── docs/
│   ├── nSpeech_SPEC.md     # This document
│   ├── API_REFERENCE.md    # API usage guide
│   ├── cosyvoice_notes.md  # CosyVoice integration notes
│   ├── nSpeech_DEV_PLAN.md # Development roadmap
│   └── handover_*.md       # Session handover notes
├── src/
│   └── nspeech/
│       ├── __init__.py
│       ├── config.py       # Environment config loader (fail-fast)
│       ├── tts.py          # Adapter protocol + engine router + LRU cache
│       ├── server.py       # FastAPI HTTP / WebSocket / static files
│       └── engines/
│           ├── kokoro.py       # Kokoro ONNX adapter (default)
│           └── chatterbox.py   # Chatterbox adapter (archived)
├── web/                    # NUI dashboard
│   ├── index.html
│   ├── css/main.css
│   ├── js/app.js
│   └── pages/
│       ├── home.html
│       ├── kokoro-generate.html
│       └── kokoro-voices.html
├── lib/
│   └── nui_wc2/            # Git submodule — NUI library
│       ├── NUI/nui.js
│       ├── NUI/css/nui-theme.css
│       └── documentation/
├── venv/                   # Per-engine virtual environments
│   ├── kokoro/
│   │   ├── env/            # Python venv
│   │   ├── models/         # ONNX weights, voice bins
│   │   └── voices/         # Voice caches (.pt) + reference audio (.wav)
│   ├── chatterbox/
│   └── cosyvoice/
└── voices_samples/         # Reference audio samples for testing
```

---

## 15. Phases

### Phase 1: Core
- [x] TTS engine adapter (Kokoro)
- [x] Voice cloning + caching
- [x] Installer + benchmark (per-engine)
- [x] Adapter interface (`generate()`, `clone()`, `load_voice()`)
- [x] FastAPI HTTP endpoints (`/tts`, `/v1/audio/speech`, `/voices/clone`, `/voices`, `/health`)
- [x] WebSocket streaming endpoint (`/ws/tts`)

### Phase 2: Streaming
- [x] Sentence-level chunking in adapter
- [x] Stream PCM chunks as generated
- [x] Multi-client support
- [x] On-the-fly transcoding (PyAV: MP3, Opus, AAC, WAV)

### Phase 3: Multi-Engine Architecture
- [x] Per-engine venv isolation
- [x] Engine selection via config or request param
- [x] Chatterbox adapter
- [x] Kokoro adapter (default)
- [x] Lazy engine loading with LRU eviction
- [x] Voice mixing (Kokoro)

### Phase 4: Dashboard
- [x] NUI Web Component framework integration
- [x] Engine-centric navigation
- [x] Kokoro generate page
- [x] Kokoro voices page

### Phase 5: Advanced Engines
- [ ] CosyVoice adapter (evaluation in progress)
- [ ] True zero-shot cloning for Kokoro
- [ ] Emotional cues / SSML support
- [ ] German language support

### Phase 6: Ops
- [ ] Metrics + logging
- [ ] Load testing
- [ ] Health checks with GPU stats
