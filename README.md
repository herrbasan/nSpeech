# nSpeech - Text-to-Speech Service

GPU-accelerated text-to-speech with zero-shot voice cloning, automatic sentence-level chunking, and streaming audio output. Engine-agnostic architecture — swap TTS backends via adapters without changing the API.

## Architecture

```
[Text Input] --> [Adapter Layer] --> [TTS Engine] --> [Voice Output]
                  (chunking +        (Kokoro or     (PCM stream)
                   streaming)         Chatterbox)
```

The adapter layer handles sentence-level chunking, voice cache management, and
PCM streaming. The underlying TTS engine is pluggable — the API and streaming
behavior stay the same regardless of backend.

| Component | Technology | Role |
|-----------|-----------|------|
| **Adapter** | Python interface | Chunking, streaming, voice cache routing |
| **TTS Engine** | Kokoro-82M (ONNX) | Default. Ultra-fast CPU rendering, low RAM (~6MB). 8 languages, 54 voices. |
| **TTS Engine** | Chatterbox | Optional fallback. ~3.8 GB VRAM. Supports true zero-shot `.wav` cloning. |
| **Server** | FastAPI + uvicorn | HTTP / WebSocket API + Dashboard UI |

## Quick Start

### 1. Install

```bash
python install.py install --models
```

This creates a self-contained `venv/`, installs PyTorch 2.8 (CUDA 12.8), Kokoro, Chatterbox, applies compatibility patches, and pre-downloads model weights.

### 2. Run

```bash
python run.py
```

All scripts (`run.py`, `benchmark.py`, `install.py`) auto-detect and use the venv — no manual activation needed. The dashboard is at `http://127.0.0.1:8000/`.

### 3. Stop

Press `Ctrl+C` in the terminal running the server.

### Other Commands

```bash
python install.py verify        # Check installation health
python install.py update        # Update packages + re-patch
python install.py models        # Download model weights only
python benchmark.py             # Run TTS benchmarks
```

## Usage

### HTTP API

```bash
# Single-shot TTS
curl -X POST http://localhost:8000/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "voice_name": "default"}' \
  --output response.wav

# Clone a voice
curl -X POST http://localhost:8000/voices/clone \
  -F "file=@reference.wav" \
  -F "name=my_voice"

# List voices
curl http://localhost:8000/voices
```

### WebSocket Streaming

Connect to `ws://localhost:8000/ws/tts` and send:

```json
{
  "type": "tts_stream",
  "text": "Here are today's headlines. First, the weather...",
  "voice_name": "default"
}
```

Receive PCM chunks as they are generated:

```json
{
  "type": "tts_chunk",
  "data": "<base64-encoded-pcm-24khz>",
  "sample_rate": 24000,
  "is_final": false
}
```

## Performance

| Metric | Target | Actual (Kokoro CPU) |
|--------|--------|---------------------|
| First audio byte | <1000 ms | ~400 - 700 ms |
| Full generation (20 words) | <1500 ms | ~1000 ms |
| Voice cache load | <10 ms | Instant |

*Note on Voice Cloning:* The default Kokoro engine does not support zero-shot voice cloning directly from .wav files due to its optimized architecture. Cloning requests via Kokoro are stubbed or require voice blending. True zero-shot extraction requires routing to the Chatterbox engine.

## Project Structure

For full API documentation including WebSocket, REST, and OpenAI API compatible endpoints, please refer to [API_REFERENCE.md](docs/API_REFERENCE.md).

```
nSpeech/
├── install.py              # Installer: install/update/verify/models
├── run.py                  # Server launcher (auto-detects venv)
├── benchmark.py            # TTS benchmark (auto-detects venv)
├── requirements/           # Per-engine dependency lists
│   ├── core.txt            # FastAPI, soundfile, numpy, etc.
│   ├── kokoro.txt          # kokoro-onnx
│   └── chatterbox.txt      # chatterbox-tts + deps
├── docs/
│   └── nSpeech_SPEC.md     # Service specification
├── src/
│   └── nspeech/
│       ├── __init__.py
│       ├── engines/
│       │   ├── chatterbox.py   # Chatterbox adapter
│       │   └── kokoro.py       # Kokoro ONNX adapter (default)
│       ├── tts.py          # Abstract protocol and engine router
│       └── server.py       # FastAPI HTTP / WebSocket server / Web UI
└── voices/                 # Voice samples & caches
    ├── *.wav
    └── *.pt                # Cached voice embeddings
```

## Notes

- **Venv**: All scripts auto-detect and re-launch inside `venv/` if needed. No manual activation required.
- **PyTorch CUDA**: The installer pins `torch==2.8.0+cu128` and reinstalls it after Chatterbox's `torch==2.6.0` dependency.
- **Patches**: The installer patches Chatterbox's watermarking module (`resemble-perth` deadlocks on Windows/Python 3.13) to use a no-op dummy watermarker.
- **Model weights**: First run downloads ~2 GB from HuggingFace. Use `--models` to pre-download during install.
- **Engine selection**: The default engine is Kokoro. Chatterbox is available as a fallback for voice cloning.
