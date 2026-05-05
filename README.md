# nSpeech - Text-to-Speech Service

GPU-accelerated text-to-speech with zero-shot voice cloning, automatic sentence-level chunking, and streaming audio output. Engine-agnostic architecture — swap TTS backends via adapters without changing the API.

## Architecture

```
[Text Input] --> [Adapter Layer] --> [TTS Engine] --> [Voice Output]
                  (chunking +        (Chatterbox    (PCM stream)
                   streaming)         or Qwen3_TTS)
```

The adapter layer handles sentence-level chunking, voice cache management, and
PCM streaming. The underlying TTS engine is pluggable — the API and streaming
behavior stay the same regardless of backend.

| Component | Technology | Role |
|-----------|-----------|------|
| **Adapter** | Python interface | Chunking, streaming, voice cache |
| **TTS Engine** | Chatterbox (default) | Zero-shot cloning, ~3.8 GB VRAM |
| **TTS Engine** | Qwen3_TTS (planned) | Higher quality, lower latency |
| **Server** | FastAPI + uvicorn | HTTP / WebSocket API |

## Quick Start

```bash
# Install
python install.py install --models

# Verify
python install.py verify

# Update packages
python install.py update

# Benchmark
python benchmark.py
```

## Usage

### Direct (Python API)

```python
from nspeech.tts import TTSEngine

# Initialize engine
tts = TTSEngine(device="cuda")

# Clone a voice (one-time)
tts.clone_voice("reference_voice.wav")
tts.save_voice_cache("my_voice")

# Load cached voice (instant)
tts.load_voice_cache("my_voice")

# Generate speech
audio = tts.generate("Hello, this is my cloned voice speaking.")

# Save output
import soundfile as sf
sf.write("output.wav", audio.cpu().squeeze().numpy(), tts.sr)
```

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

| Metric | Target |
|--------|--------|
| First audio byte | <1000 ms |
| Full generation (20 words) | <1500 ms |
| Voice cloning | <2000 ms |
| Voice cache load | <10 ms |
| Model cold start | <5000 ms |

## Project Structure

For full API documentation including WebSocket, REST, and OpenAI API compatible endpoints, please refer to [API_REFERENCE.md](docs/API_REFERENCE.md).

```
nSpeech/
├── install.py              # Installer: install/update/verify/models
├── requirements.txt        # Python dependencies
├── benchmark.py            # TTS benchmark
├── README.md               # This file
├── SPEC.md                 # Service specification
├── STT_SPEC.md             # STT bits for nVoice project
├── src/
│   └── nspeech/
│       ├── __init__.py
│       ├── adapter.py      # TTS adapter interface + chunking
│       ├── engines/
│       │   ├── __init__.py
│       │   ├── chatterbox.py   # Chatterbox adapter
│       │   └── qwen3.py        # Qwen3_TTS adapter (planned)
│       ├── tts.py          # Chatterbox wrapper (legacy)
│       └── server.py       # FastAPI HTTP / WebSocket server
└── voices/                 # Voice samples & caches
    ├── *.wav
    └── *.pt                # Cached voice embeddings
```

## Installer Commands

```bash
python install.py install       # Fresh install
python install.py install --models  # + pre-download weights
python install.py update        # Update all packages
python install.py verify        # Check installation health
python install.py models        # Download model weights only
```

## Notes

- **PyTorch CUDA**: The installer handles the `chatterbox-tts` → `torch==2.6.0` (CPU) dependency conflict by reinstalling the CUDA-enabled PyTorch after requirements.
- **Patches**: The installer automatically patches Chatterbox's watermarking module for Windows/CUDA 13 compatibility.
- **Model weights**: First run downloads ~2 GB from HuggingFace. Use `--models` to pre-download during install.
- **Engine selection**: The default engine is Chatterbox. Qwen3_TTS adapter is planned for higher quality / lower latency.
