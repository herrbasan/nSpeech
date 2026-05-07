# nSpeech Service Specification

## 1. Overview

nSpeech is a self-hosted, GPU-accelerated text-to-speech service. It takes text
input and returns natural-sounding speech audio. Key features:

- **Engine-agnostic architecture** — pluggable TTS adapters; same API and streaming behavior regardless of backend
- **Zero-shot voice cloning** from a short reference audio clip
- **Voice caching** — cloned voices persist as small files, reload in <10 ms
- **Automatic text chunking** — long input is split into sentence-level chunks
- **Streaming** — audio chunks are emitted as they are generated
- **Optional transcoding** — raw PCM for local clients, WebM/Opus or MP3 for browser fetch streaming
- **Low latency** — first audio byte in <1 s (warmed up)

The service exposes HTTP and WebSocket endpoints. Callers send text and receive
audio. The underlying TTS engine is an implementation detail — the chunking,
streaming, and API surface stay the same across adapters.

---

## 2. Goals

- Provide a technology-agnostic TTS service surface — swap engines via adapters
- Synthesize natural speech from arbitrary text in <1 s to first byte
- Clone voices from reference audio in <2 s
- Stream audio chunks as they are generated (no waiting for full file)
- Handle long text automatically via sentence-level chunking
- Run entirely on consumer GPU
- Provide a clean HTTP/WebSocket API for integration by any caller
- Output browser-native formats (WebM/Opus, MP3) for direct fetch streaming

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  nSpeech Service                                            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  HTTP / WebSocket API  (FastAPI + uvicorn)          │   │
│  │                                                     │   │
│  │  POST /tts           — single-shot synthesis        │   │
│  │  GET  /tts/stream    — streaming synthesis          │   │
│  │  POST /voices/clone  — clone voice from audio       │   │
│  │  GET  /voices        — list available voices        │   │
│  │  GET  /health        — health + model status        │   │
│  │  WS   /ws/tts        — streaming synthesis          │   │
│  └─────────────────────────────────────────────────────┘   │
│                        │                                    │
│                        ▼                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  TTS Adapter Layer                                  │   │
│  │  • Normalized voice cache format                    │   │
│  │  • Sentence-level chunking                          │   │
│  │  • PCM chunk streaming                              │   │
│  │  • Abstract: generate(), clone(), load_voice()      │   │
│  └─────────────────────────────────────────────────────┘   │
│                        │                                    │
│            ┌───────────┴───────────┐                        │
│            ▼                       ▼                        │
│  ┌─────────────────┐   ┌─────────────────┐                 │
│  │ Chatterbox      │   │ Kokoro       │                 │
│  │ (default)       │   │ (planned)       │                 │
│  │ ~3.8 GB VRAM    │   │ lower latency   │                 │
│  │ zero-shot clone │   │ higher quality  │                 │
│  └─────────────────┘   └─────────────────┘                 │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Transcoding Layer (optional, on-demand)            │   │
│  │  • PCM → WebM/Opus (streaming)                      │   │
│  │  • PCM → MP3 (compatibility)                        │   │
│  │  • PCM → WAV (single-shot)                          │   │
│  │  • PyAV (libav/ffmpeg), near-zero-copy              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Component Responsibilities

| Component | Technology | Role |
|-----------|-----------|------|
| **API** | FastAPI + uvicorn | HTTP / WebSocket endpoints, request routing |
| **Adapter** | Python interface | Chunking, streaming, voice cache management |
| **TTS Engine** | Chatterbox (default) | Synthesize speech, clone voices |
| **TTS Engine** | Kokoro (planned/eval) | Ultra-low latency, 82M params, expressive |
| **Transcoder** | PyAV (optional) | PCM → WebM/Opus/MP3 on demand |

### 3.2 Concurrency & GPU Locking
GPU VRAM is a constrained resource. To prevent Out-Of-Memory (OOM) errors during parallel requests, the core inference pipeline is gated by a global asynchronous lock (`asyncio.Lock()`). Multiple callers connecting simultaneously will have their chunks queued FIFO style. Streaming allows multiplexing at the sentence level (caller A gets sentence 1, caller B gets sentence 1, caller A gets sentence 2, etc.), ensuring no single long request starves the service.

### 3.3 Text Chunking Fallback
The adapter splits text by sentence punctuation. If a request provides a maliciously or abnormally long string without punctuation (e.g., 500 words of continuous text), the adapter enforces a strict maximum character limit per chunk (e.g., 200 chars). It will split at the nearest space boundary before the limit to prevent the TTS engine from exceeding its context window and crashing.

---

## 4. Configuration

The service relies entirely on explicit environment variables (or a minimal `config.py` parser reading the environment) to dictate startup behavior, memory retention, and port bindings. If required values are missing, the service fails fast at startup.

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `NSPEECH_ENGINE` | The TTS adapter backend to use (e.g., `chatterbox`, `kokoro`) | Yes | - |
| `NSPEECH_HOST` | The IP to bind the HTTP/WS socket (e.g., `127.0.0.1` or `0.0.0.0`) | No | `127.0.0.1` |
| `NSPEECH_PORT` | The port for the service | No | `8000` |
| `NSPEECH_VOICE_DIR` | Absolute or relative path to the directory storing reference audios and `.pt` voice caches | Yes | - |
| `NSPEECH_MODEL_DIR` | Directory to store large TTS engine weights (e.g., HuggingFace models). Avoids redownloading on restart. | Yes | - |
| `NSPEECH_API_KEY` | If provided, restricts all HTTP/WS endpoints requiring a `Bearer <token>`. Leave empty for open access. | No | `""` |
| `NSPEECH_PRELOAD_MODEL` | Provide `'true'` to immediately load the model into VRAM on startup, halting on failure. | No | `'false'` |
| `NSPEECH_MODEL_IDLE_TIMEOUT_SEC` | Time in seconds before evicting an idle model from VRAM. `0` means never evict (permanently resident). | No | `0` |
| `NSPEECH_LOG_LEVEL` | Logging verbosity (`DEBUG`, `INFO`, `WARNING`, `ERROR`) | No | `INFO` |

---

## 5. Generation Flow

### 5.1 Single-Shot (HTTP)

```
Caller POST /tts
  {
    "text": "Turning on the lights.",
    "voice_name": "default",
    "output_format": "wav"
  }

  0 ms  Receive request
 50 ms  Load voice cache (if not already loaded)
800 ms  TTS engine generates audio
820 ms  Transcode to WAV (if requested)
850 ms  Response: audio/wav
```

### 5.2 Narration Mode (HTTP — Non-Streaming)

For higher-quality, expressive output (audiobook narration, acting, long-form content), the
service offers a non-streaming generation mode. Text is still automatically chunked at the
sentence level internally, but the entire audio is assembled server-side before returning a
single complete audio file.

```
Caller POST /tts
  {
    "text": "Long narration text...",
    "voice_name": "default",
    "mode": "narration",
    "output_format": "wav"
  }

   0 ms  Receive request
  50 ms  Load voice cache
 800 ms  Sentence 1 generated
1500 ms  Sentence 2 generated
2200 ms  Sentence 3 generated
   ...   Continue until all sentences done
2400 ms  Concatenate all chunks into single audio
2450 ms  Transcode to requested format
2500 ms  Response: complete audio/wav
```

**When to use narration mode:**
- Audiobook or podcast-style generation where consistency across sentences matters
- Higher-quality engine backends that don't support incremental streaming
- Offline batch processing where latency is not a concern

**When to use streaming mode (default):**
- Real-time conversational TTS
- Live narration where first-byte latency matters
- Interactive voice assistants

```
Browser: fetch("/tts/stream?text=...&voice=default&format=opus")

   0 ms  Receive request
  50 ms  Load voice cache
 600 ms  Chunk 1 PCM generated
 610 ms  Chunk 1 encoded to WebM/Opus
 615 ms  Streamed to browser
 900 ms  Chunk 2 PCM generated
 910 ms  Chunk 2 encoded to WebM/Opus
 915 ms  Streamed to browser
  ...   Continue until complete

Total: ~615 ms to first playable audio byte
```

The browser receives a continuous WebM/Opus stream that it can feed directly
to `<audio>` or decode via `MediaSource`. No client-side transcoding needed.

### 4.3 Streaming (WebSocket)

```
Caller WS /ws/tts
  {
    "type": "tts_stream",
    "text": "Here are today's headlines. First, the weather...",
    "voice_name": "default",
    "output_format": "pcm"
  }

   0 ms  Receive request
  50 ms  Load voice cache
 600 ms  Chunk 1 PCM streamed  ("Here are today's headlines.")
 900 ms  Chunk 2 PCM streamed  ("First, the weather...")
 950 ms  {is_final: true}
```

Text is split into sentences. Each sentence is synthesized independently and
streamed as a chunk. The caller receives playable audio faster and can start
playback while later chunks are still generating. The adapter handles this
regardless of which TTS engine is loaded.

### 4.4 Voice Cloning

```
Caller POST /voices/clone
  multipart: file=reference.wav, name="my_voice"

   0 ms  Receive reference audio
 500 ms  TTS engine extracts voice embedding
1200 ms  Save cache: voices/my_voice.pt
1250 ms  Response: {voice_name: "my_voice", ...}
```

---

## 6. Output Formats

| Format | Container | Codec | Content-Type | Best For |
|--------|-----------|-------|-------------|----------|
| `pcm` | None | Raw PCM | `application/octet-stream` | Local clients, WebSocket |
| `wav` | RIFF | PCM | `audio/wav` | Single-shot HTTP, compatibility |
| `opus` | WebM | Opus | `audio/webm` | Browser streaming, best compression |
| `mp3` | None | MP3 | `audio/mpeg` | Universal browser support |

**Default:** `wav` for single-shot HTTP, `pcm` for WebSocket.

**WebM/Opus streaming:** The server outputs a WebM container with Opus audio
that browsers can play progressively. Each sentence chunk is encoded and
muxed into the container on-the-fly. The browser starts playback after
receiving the first few KB of the stream.

---

## 7. API

If `NSPEECH_API_KEY` is configured, all HTTP endpoints must provide the HTTP header:
`Authorization: Bearer <token>`
For WebSockets, auth can be passed as a query parameter `?token=<token>`.

### 7.1 HTTP Layer Errors

All HTTP endpoints use standard status codes for reporting failures:
*   `400 Bad Request` — Missing parameters, unsupported output format, or invalid voice name requested.
*   `401 Unauthorized` — Missing or invalid `NSPEECH_API_KEY`.
*   `422 Unprocessable Entity` — Audio file provided for cloning is corrupt or invalid.
*   `500 Internal Server Error` — Generation failed internally within the TTS engine.
*   `503 Service Unavailable` — Unable to load the TTS engine into VRAM, GPU exhausted, or service heavily overloaded.

Error responses always return JSON:
```json
{
  "error": "MODEL_LOAD_FAILED",
  "message": "Insufficient VRAM to load Kokoro model."
}
```

### 7.2 HTTP Endpoints

#### `POST /tts`
Synthesis endpoint. By default streams audio chunks as they are generated. Set `mode` to `"narration"` to receive a single complete audio file instead — intended for high-quality, long-form generation where first-byte latency is not a concern (audiobooks, acting, batch processing).

**Request:**
```http
POST /tts
Content-Type: application/json

{
  "text": "Turning on the lights.",
  "voice_name": "default",
  "engine": "kokoro",          // Optional: overrides the default NSPEECH_ENGINE for this request
  "mode": "streaming",         // Optional: "streaming" (default) or "narration" (non-streaming, higher quality)
  "exaggeration": 0.5,
  "output_format": "wav",
  "transcode_bitrate": "128k",
  "transcode_sample_rate": 24000
}
```

**Response:**
```http
Content-Type: audio/wav
<binary audio data>
```

#### `POST /v1/audio/speech` (OpenAI Compatible)
Drop-in replacement for the OpenAI TTS API. Useful for integrating `nSpeech` with external tools, agents, and libraries that expect the OpenAI schema.

**Request:**
```http
POST /v1/audio/speech
Content-Type: application/json

{
  "model": "kokoro",           // Maps to `engine` parameter to dynamically select backend
  "input": "Turning on the lights.", // Maps to `text`
  "voice": "default",         // Maps to `voice_name`
  "response_format": "mp3",   // Maps to `output_format` (mp3, opus, aac, flac, wav, pcm)
  "speed": 1.0                // Maps to `exaggeration` equivalent
}
```

**Response:**
```http
Content-Type: audio/mpeg
<binary audio data>
```

#### `GET /tts/stream`
Streaming synthesis. Returns a continuous audio stream. Browser-friendly.

**Request:**
```http
GET /tts/stream?text=Turning%20on%20the%20lights&voice_name=default&format=opus&bitrate=64k&sample_rate=24000
```

**Response:**
```http
Content-Type: audio/webm
Transfer-Encoding: chunked

<continuous WebM/Opus stream>
```

The browser can consume this via:

```javascript
const audio = new Audio();
audio.src = "/tts/stream?text=Hello%20world&voice_name=default&format=opus";
audio.play();
```

Or with fetch for custom handling:

```javascript
const response = await fetch("/tts/stream?text=...&format=opus");
const reader = response.body.getReader();
// Feed chunks to MediaSource or Web Audio API
```

#### `POST /voices/clone`
Accepts a reference audio clip and saves it directly into the directory specified by `NSPEECH_VOICE_DIR`. It then triggers the specified (or default) TTS backend to compute its embedding (cache object). Caches are saved with an engine-specific extension (e.g., `voices/my_voice.chatterbox.pt`). Because the original `.wav` is stored, switching to a different backend engine in the future will automatically re-compute embeddings cleanly from the source audio when requested.

**Request:**
```http
POST /voices/clone
Content-Type: multipart/form-data

file: <reference audio (.wav)>
name: "my_voice"
engine: "kokoro"
exaggeration: 0.5
```

**Response:**
```json
{
  "voice_name": "my_voice",
  "engine": "kokoro",
  "cache_file": "voices/my_voice.kokoro.pt",
  "source_file": "voices/my_voice.wav",
  "file_size_bytes": 101127,
  "clone_time_ms": 1250
}
```

#### `GET /voices`
Lists all available voices by scanning `NSPEECH_VOICE_DIR`. Any `.wav` file is recognized as an available cloneable reference. It aggregates the compilation state of each engine by checking for `.engine.pt` files, helping clients choose which engine to route to.

**Response:**
```json
{
  "voices": [
    {
      "name": "default", 
      "source_file": "default.wav",
      "engines": [
        {"name": "chatterbox", "cached": true, "latency_tier": "standard"},
        {"name": "kokoro", "cached": true, "latency_tier": "low"}
      ]
    },
    {
      "name": "my_voice", 
      "source_file": "my_voice.wav",
      "engines": [
        {"name": "chatterbox", "cached": true, "latency_tier": "standard"},
        {"name": "kokoro", "cached": false, "latency_tier": "low"}
      ]
    }
  ]
}
```

#### `GET /health`

**Response:**
```json
{
  "status": "healthy",
  "engine": "chatterbox",
  "tts_loaded": true,
  "gpu": "NVIDIA GeForce RTX 4090",
  "vram_used_mb": 3800,
  "vram_total_mb": 24576
}
```

### 7.2 WebSocket (`/ws/tts`)

**Client → Server:**

```json
{
  "type": "tts_stream",
  "text": "Turning on the lights.",
  "voice_name": "default",
  "engine": "kokoro",
  "exaggeration": 0.5,
  "output_format": "pcm"
}
```

```json
{
  "type": "clone_voice",
  "audio_data": "<base64-encoded-wav>",
  "voice_name": "user_voice_1",
  "engine": "kokoro",
  "exaggeration": 0.5
}
```

```json
{
  "type": "set_voice",
  "voice_name": "user_voice_1"
}
```

**Server → Client:**

```json
{
  "type": "tts_chunk",
  "data": "<base64-encoded-pcm-24khz>",
  "sample_rate": 24000,
  "is_final": false
}
```

```json
{
  "type": "voice_cloned",
  "voice_name": "my_voice",
  "engine": "kokoro",
  "cache_file": "voices/my_voice.kokoro.pt",
  "clone_time_ms": 1250
}
```

```json
{
  "type": "error",
  "code": "MODEL_NOT_LOADED",
  "message": "TTS model is not initialized"
}
```

---

## 8. State

```
┌─────────────┐
│    IDLE     │  Server running, model not loaded
└──────┬──────┘
       │ request received
       ▼
┌─────────────┐
│  LOADING    │  Load TTS engine into VRAM
└──────┬──────┘
       │ model ready
       ▼
┌─────────────┐
│  GENERATING │  Synthesize audio (single-shot or streaming)
└──────┬──────┘
       │ done / connection closed
       ▼
┌─────────────┐
│    IDLE     │  Keep model loaded (LRU eviction)
└─────────────┘
```

---

## 9. VRAM

| GPU | Chatterbox | Kokoro (planned) |
|-----|-----------|---------------------|
| RTX 4090 (24 GB) | ~3.8 GB | TBD |
| RTX 5090 (32 GB) | ~3.8 GB | TBD |

---

## 10. Performance

| Metric | Target |
|--------|--------|
| First audio byte | <1000 ms |
| Full generation (20 words) | <1500 ms |
| Voice cloning | <2000 ms |
| Voice cache load | <10 ms |
| Model cold start | <5000 ms |

---

## 11. Adapter Interface

To guarantee seamless swapping of backends without changing the server layer, every TTS engine must implement the standard Adapter Interface. Adapters are responsible for loading their specific model, generating raw 24kHz float32 mono PCM data, and compiling embeddings from audio. 

```python
import torch
from typing import Iterator, Tuple

class BaseTTSAdapter:
    def __init__(self):
        # Initialization must be light. Do NOT load weights into VRAM here.
        pass

    def load_model(self) -> None:
        """Move the model weights into GPU VRAM."""
        pass

    def unload_model(self) -> None:
        """Clear model from VRAM and run garbage collection/empty_cache."""
        pass

    def generate(self, text: str, voice_name: str, exaggeration: float = 0.5) -> Iterator[Tuple[torch.Tensor, bool]]:
        """
        Generate audio dynamically.
        Yields (audio_data, is_final). audio_data must be a flat torch.Tensor 
        of float32 PCM at 24kHz.
        """
        pass

    def clone_voice(self, audio_path: str, voice_name: str) -> str:
        """
        Compute the engine-specific voice embedding from the reference audio.
        Save the compiled embedding to NSPEECH_VOICE_DIR / <voice_name>.pt
        Returns the path to the saved cache file.
        """
        pass
```

---

## 12. Technology

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Python | CPython | 3.13+ | |
| PyTorch | CUDA nightly | 2.12.0+cu128 | RTX 5090 sm_120 support |
| TTS Adapter | Python interface | — | Chunking, streaming, cache |
| TTS Engine | chatterbox-tts | 0.1.7 | Default adapter |
| TTS Engine | Kokoro | — | Planned adapter |
| Transcoding | PyAV | latest | Optional, on-demand |
| Server | FastAPI + uvicorn | latest | |
| Audio I/O | soundfile | 0.13+ | WAV read/write |

---

## 13. Installation

```bash
python install.py install --models
python install.py verify
```

Handles venv creation, PyTorch CUDA install, chatterbox patching, and optional
model pre-download. PyAV is installed as an optional dependency for transcoding
support.

---

## 14. Project Structure

```
nSpeech/
├── install.py              # Installer
├── requirements.txt        # Dependencies
├── benchmark.py            # Benchmark
├── SPEC.md                 # This document
├── README.md               # User docs
├── STT_SPEC.md             # STT bits for nVoice project
├── src/
│   └── nspeech/
│       ├── __init__.py
│       ├── adapter.py      # TTS adapter interface + chunking
│       ├── transcoder.py   # Optional: PyAV transcoding
│       ├── engines/
│       │   ├── __init__.py
│       │   ├── chatterbox.py   # Chatterbox adapter
│       │   └── kokoro.py        # Kokoro adapter (planned)
│       ├── tts.py          # Chatterbox wrapper (legacy)
│       └── server.py       # FastAPI server
└── voices/                 # Voice samples & caches
    ├── *.wav
    └── *.pt
```

---

## 15. Phases

### Phase 1: Core
- [x] TTS engine (Chatterbox)
- [x] Voice cloning + caching
- [x] Installer + benchmark
- [ ] Adapter interface (`generate()`, `clone()`, `load_voice()`)
- [ ] FastAPI HTTP endpoints (`/tts`, `/v1/audio/speech`, `/voices/clone`, `/voices`, `/health`)
- [ ] WebSocket streaming endpoint (`/ws/tts`)

### Phase 2: Streaming
- [ ] Sentence-level chunking in adapter
- [ ] Stream PCM chunks as generated
- [ ] Multi-client support

### Phase 3: Kokoro Adapter
- [ ] Kokoro engine adapter
- [ ] Engine selection via config or request param
- [ ] Benchmark comparison (Chatterbox vs Kokoro)

### Phase 4: Transcoding
- [ ] PyAV integration for on-the-fly encoding
- [ ] `GET /tts/stream` endpoint (WebM/Opus, MP3)
- [ ] Browser compatibility testing
- [ ] Bandwidth comparison (PCM vs Opus vs MP3)

### Phase 5: Ops
- [ ] Metrics + logging
- [ ] Load testing
