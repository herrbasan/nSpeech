# nSpeech — Pluggable Text-to-Speech Service V3

Multi-engine TTS with a unified OpenAI-compatible API. Local engines (Kokoro, CosyVoice, Chatterbox, dots.tts) run in per-engine Python venvs managed by a Node.js proxy. Cloud providers (MiniMax, ElevenLabs) run as native Node adapters — no Python, no venv, no GPU.

## Architecture

```
Client (dashboard / curl / Gateway)
  │  POST /v1/audio/speech  { model: "minimax", input: "...", voice: "..." }
  ▼
Node.js (Fastify) — routing, engine resolution, ffmpeg transcode
  ├─ Cloud adapter (fetch → raw PCM → pipePcmToClient)
  │    minimax, elevenlabs
  └─ Python worker (child_process → HTTP relay → PCM)
       kokoro, cosyvoice, chatterbox, dots
```

Node owns all codec output. Every engine emits raw PCM (s16le, 24 kHz, mono). Node's `pipePcmToClient` transcodes PCM→MP3/Opus/AAC via bundled ffmpeg (`lib/nvideo`). One shared streaming path for all engines and providers.

## Quick Start

### 1. Configure

Set `NSPEECH_ENGINE=kokoro` in `.env` and add cloud API keys as needed.

### 2. Install (local engines only)

```bash
python install.py install --engine kokoro --models
```

Creates `venv/kokoro/env/`, installs dependencies, downloads model weights. Cloud providers don't need installation.

### 3. Run

```bash
node server/index.js
```

Dashboard at `http://127.0.0.1:2233/`. Port is configurable in `config.json` (overridden by `NSPEECH_PORT` in `.env`).

### 4. Stop

Press `Ctrl+C`. Node kills all Python worker process groups on shutdown.

## Engines

| Engine | Type | Hardware | Voices | Cloning |
|--------|------|----------|--------|---------|
| **Kokoro** | Local | CPU (~6 MB) | 54 built-in | Stub (fallback) |
| **CosyVoice** | Local | GPU (~3.5 GB) | Clone-only | Zero-shot |
| **Chatterbox** | Local | GPU (~10 GB) | Clone-only | Zero-shot |
| **dots.tts** | Local | GPU | Clone-only | Zero-shot |
| **MiniMax** | Cloud | — | 332+ system | Instant (API) |
| **ElevenLabs** | Cloud | — | 10,000+ | Professional |

Cloud adapters are stateless — no process spawn, no GPU exclusion. Local GPU engines are mutually exclusive (one GPU engine resident at a time). Switch engines from the dashboard home page.

## API (OpenAI-compatible)

```bash
# Generate speech
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"minimax","input":"Hello world.","voice":"English_expressive_narrator","response_format":"mp3"}' \
  --output out.mp3

# List voices
curl http://127.0.0.1:2233/v1/voices?engine=elevenlabs

# Clone a voice
curl -X POST http://127.0.0.1:2233/v1/voices/clone?engine=elevenlabs \
  -F "name=my_voice" -F "audio=@reference.wav"

# Switch engine (SSE stream)
curl -N -X POST http://127.0.0.1:2233/v1/admin/engine \
  -H "Content-Type: application/json" -d '{"engine":"dots"}'
```

Full spec: [docs/AUDIO_API_PLAN.md](docs/AUDIO_API_PLAN.md) (API contract) and [documentation/API_REFERENCE.md](documentation/API_REFERENCE.md) (reference).

## Project Structure

```
nSpeech/
├── server/                 # Node.js API server
│   ├── index.js            # Fastify bootstrap
│   ├── config.js           # config.json + .env loader
│   ├── transcode.js        # ffmpeg PCM→MP3/Opus/AAC relay
│   ├── logger.js           # nLogger adapter
│   ├── api/                # Route handlers
│   │   ├── speech.js       # POST /v1/audio/speech
│   │   ├── voices.js       # GET|POST|DELETE /v1/voices/*
│   │   ├── admin.js        # POST /v1/admin/engine
│   │   └── formats.js
│   ├── engine/             # Engine worker management
│   │   ├── manager.js      # getEngine(), switchEngine()
│   │   ├── worker.js       # WorkerProcess (spawn, relay, health)
│   │   └── registry.js     # Local engine registry
│   └── cloud/              # Cloud provider adapters
│       ├── registry.js     # Cloud engine routing
│       ├── minimax.js      # MiniMax adapter
│       └── elevenlabs.js   # ElevenLabs adapter
├── src/nspeech/            # Python engine layer
│   ├── config.py
│   ├── worker_routes.py    # Worker HTTP endpoints
│   ├── worker_server.py    # uvicorn entry point
│   └── engines/            # Per-engine adapters
│       ├── kokoro.py
│       ├── cosyvoice.py
│       ├── chatterbox.py
│       └── dots.py
├── web/                    # NUI dashboard
│   ├── index.html
│   ├── js/app.js           # Engine-aware navigation
│   ├── css/main.css
│   └── pages/              # Per-engine pages
│       ├── home.html
│       ├── kokoro/
│       ├── cosyvoice/
│       ├── chatterbox/
│       ├── dots/
│       ├── minimax/
│       └── elevenlabs/
├── lib/
│   ├── nui_wc2/            # Git submodule — NUI Web Components
│   ├── nlogger/            # Git submodule — unified logging
│   └── nvideo/             # Git submodule — bundled ffmpeg
├── docs/
│   ├── AUDIO_API_PLAN.md   # Canonical API contract
│   ├── AUDIO_API_DEV_PLAN.md
│   └── providers/          # Provider-specific docs
│       ├── minimax.md
│       └── elevenlabs.md
├── documentation/
│   └── API_REFERENCE.md    # Project API reference
├── voices_samples/         # Reference audio for testing
├── venv/                   # Per-engine virtual environments
├── requirements/           # Per-engine dependency lists
└── install.py              # Per-engine venv installer
```

## Documentation

- [docs/AUDIO_API_PLAN.md](docs/AUDIO_API_PLAN.md) — Canonical API surface and `extra_body` schema
- [docs/AUDIO_API_DEV_PLAN.md](docs/AUDIO_API_DEV_PLAN.md) — Development phases and implementation status
- [documentation/API_REFERENCE.md](documentation/API_REFERENCE.md) — Concise endpoint reference with examples
- [docs/providers/minimax.md](docs/providers/minimax.md) — MiniMax speech API reference
- [docs/providers/elevenlabs.md](docs/providers/elevenlabs.md) — ElevenLabs speech API reference
- [Agents.md](Agents.md) — LLM agent guidance for this codebase
