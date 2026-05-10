# nSpeech - Text-to-Speech Service

Pluggable text-to-speech with automatic sentence-level chunking, streaming audio output,
and per-engine virtual environment isolation. Swap TTS backends via adapters without
changing the API.

## Architecture

```
[Text Input] --> [Adapter Layer] --> [TTS Engine] --> [Voice Output]
                   (chunking +        (Kokoro,         (PCM 24kHz)

                    streaming)         CosyVoice,       mono float32)
The adapter layer handles sentence-level chunking, voice cache management, and
PCM streaming. The underlying TTS engine is pluggable — the API and streaming
behavior stay the same regardless of backend.

| Component | Technology | Role |
|-----------|-----------|------|
| **Adapter** | Duck-typed Python | Chunking, streaming, voice cache routing |
| **TTS Engine** | Kokoro-82M (ONNX) | Default. Ultra-fast CPU rendering, ~6MB RAM. 54 built-in voices. Consistent pacing. |

| **TTS Engine** | Chatterbox (GPU) | Zero-shot cloning. 3 models: Turbo (350M, paralinguistic), English (500M), Multilingual (500M, 23 languages). ~10 GB VRAM total. |

| **TTS Engine** | CosyVoice3-0.5B (GPU) | GPU required (~3.5 GB VRAM). Multilingual (9 languages), zero-shot voice cloning. Known prosody jitter on short phrases. 1.5B model unreleased. |
| **Server** | FastAPI + uvicorn | HTTP / WebSocket API + Dashboard UI |
| **Dashboard** | NUI (Web Components) | Browser UI — engine-centric navigation |

## Quick Start

### 1. Configure

Copy `.env.example` to `.env` and set your engine:

```bash
NSPEECH_ENGINE=kokoro
NSPEECH_VOICE_DIR=venv/kokoro/voices
NSPEECH_MODEL_DIR=venv/kokoro/models
```

### 2. Install

Per-engine installation:

```bash
python install.py install --engine kokoro --models
```

This creates `venv/kokoro/env/`, installs dependencies, and downloads model weights.

### 3. Run

```bash
python run.py
```

All scripts (`run.py`, `benchmark.py`, `install.py`) auto-detect and use the correct
venv — no manual activation needed. The dashboard is at `http://127.0.0.1:8000/`.

### 4. Stop

Press `Ctrl+C` in the terminal running the server.

### Other Commands

```bash
python install.py verify --engine kokoro     # Check installation health
python install.py update --engine kokoro     # Update packages
python install.py models --engine kokoro     # Download model weights only
python benchmark.py                           # Run TTS benchmarks
```

## Usage

### HTTP API

```bash
# Single-shot TTS (streaming)
curl -X POST http://localhost:8000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "voice_name": "af_heart", "output_format": "mp3"}' \
  --output response.mp3

# OpenAI compatible endpoint
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "kokoro", "input": "Hello world", "voice": "af_heart", "response_format": "mp3"}' \
  --output response.mp3

# Clone a voice (Chatterbox engine)
curl -X POST http://localhost:8000/voices/clone \
  -F "file=@reference.wav" \
  -F "name=my_voice" \
  -F "engine=chatterbox"

# Mix two Kokoro voices
curl -X POST http://localhost:8000/voices/mix \
  -H "Content-Type: application/json" \
  -d '{"name": "blend", "voice_a": "af_heart", "voice_b": "am_michael", "ratio": 0.5}'

# List voices
curl http://localhost:8000/voices
```

### WebSocket Streaming

Connect to `ws://localhost:8000/ws/tts` and send:

```json
{
  "type": "tts_stream",
  "text": "Here are today's headlines. First, the weather...",
  "voice_name": "af_heart",
  "output_format": "mp3"
}
```

Receive encoded audio chunks as binary frames, followed by:

```json
{"is_final": true}
```

## Performance

| Metric | Target | Actual (Kokoro CPU) |
|--------|--------|---------------------|
| First audio byte | <1000 ms | ~400-700 ms |
| Full generation (20 words) | <1500 ms | ~1000 ms |
| Voice cache load | <10 ms | Instant |
| Model cold start | <5000 ms | <1 s |

## Project Structure

```
nSpeech/
├── install.py              # Per-engine installer
├── run.py                  # Server launcher (auto-detects venv)
├── benchmark.py            # TTS benchmark (auto-detects venv)
├── requirements/           # Per-engine dependency lists
│   ├── core.txt            # FastAPI, soundfile, numpy, etc.
│   ├── kokoro.txt          # kokoro-onnx
│   ├── chatterbox.txt      # chatterbox-tts + deps
│   └── cosyvoice.txt       # CosyVoice deps
├── docs/
│   ├── nSpeech_SPEC.md     # Full service specification
│   ├── API_REFERENCE.md    # API usage examples
│   ├── cosyvoice_notes.md  # CosyVoice integration notes
│   └── nSpeech_DEV_PLAN.md # Development roadmap
├── src/
│   └── nspeech/
│       ├── config.py       # Environment config (fail-fast)
│       ├── tts.py          # Adapter protocol + engine router
│       ├── server.py       # FastAPI HTTP / WebSocket server
│       └── engines/
│           ├── kokoro.py       # Kokoro ONNX adapter (default)
│           ├── cosyvoice.py    # CosyVoice3 adapter
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
├── venv/                   # Per-engine virtual environments
│   ├── kokoro/
│   ├── chatterbox/
│   └── cosyvoice/
└── voices_samples/         # Reference audio samples
```

For full API documentation including WebSocket, REST, and OpenAI API compatible
endpoints, please refer to [docs/API_REFERENCE.md](docs/API_REFERENCE.md).

## Engine Differences

| Feature | Kokoro | Chatterbox | CosyVoice3-0.5B |
|---------|--------|------------|------------------|
| Hardware | CPU | GPU (CUDA, ~10 GB VRAM) | GPU (CUDA, ~3.5 GB) |
| RAM/VRAM | ~6 MB | ~10 GB (3 models) | ~3.5 GB |
| Built-in voices | 54 | 0 (clone required) | 0 (clone required) |
| Voice cloning | Stubbed (fallback) | True zero-shot | True zero-shot |
| Voice mixing | Yes | No | No |
| Languages | English (+ partial) | 23 languages | 9 languages |
| Latency | Very low | Medium (~400ms TTFA) | Medium (~1.5s TTFA) |
| Prosody | Consistent | Good | Variable (0.5B limitation) |
| Paralinguistic tags | No | Turbo: [laugh], etc. | Inline emotion tags |
| Streaming | Yes (internal) | Yes (per-sentence) | Yes (per-sentence) |

**Note on CosyVoice3 Prosody:** The 0.5B model has known pacing jitter — speaking rate varies
per sentence, with odd pauses on short phrases. The 1.5B model (unreleased) is expected to fix
this. Kokoro-82M remains the benchmark for consistent pacing.

## Notes

- **Venvs**: All scripts auto-detect and re-launch inside the correct `venv/<engine>/env/`
  if needed. No manual activation required.
- **Per-engine isolation**: Each engine has its own venv to prevent dependency conflicts
  (e.g., CosyVoice needs transformers 4.51.3, others need 5.x).
- **Model weights**: First run downloads ~2 GB from HuggingFace. Use `--models` to
  pre-download during install.
- **Engine selection**: The default engine is Kokoro. Set `NSPEECH_ENGINE` in `.env`
  to switch. Individual requests can override via the `engine` parameter.
- **Patches**: The installer patches Chatterbox's watermarking module (`resemble-perth`
  deadlocks on Windows/Python 3.13) to use a no-op dummy watermarker.
