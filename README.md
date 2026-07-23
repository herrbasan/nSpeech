# nSpeech

Multi-engine Text-to-Speech with a unified OpenAI-compatible API. Run local GPU models (Kokoro, Chatterbox) and cloud providers (MiniMax, ElevenLabs, Gemini, xAI) behind one simple HTTP interface.

## What You Get

- **One API** — OpenAI-compatible `POST /v1/audio/speech` for all engines
- **Multiple engines** — local (Kokoro, Chatterbox Turbo) + cloud (MiniMax, ElevenLabs, Gemini, xAI)
- **Voice library** — native system voices, cloned voices, and saved presets
- **Streaming** — real-time PCM → MP3/Opus/AAC via ffmpeg
- **Simple integration** — standard JSON in, audio out

## Quick Start

### 1. Install & Run

```bash
# Install Node dependencies
npm install

# Install default engine (Kokoro)
python install.py install

# Add API keys for cloud providers (optional)
cp .env.example .env
# Edit .env with your keys

# Start
npm start
```

Dashboard (admin UI) at `http://127.0.0.1:2233/`.

### 2. Generate Speech

```bash
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kokoro",
    "input": "Hello world.",
    "voice": "af_heart",
    "response_format": "mp3"
  }' \
  --output hello.mp3
```

### 3. List Voices

```bash
curl http://127.0.0.1:2233/v1/voices?engine=kokoro
```

Returns native, cloned, and preset voices. Use any `voice_id` in the `voice` field.

## Integration

### SDK (Recommended)

The nSpeech Client SDK (`lib/nspeech-client/nspeech-client-v2.js`) is a zero-dependency vanilla JS client for browser and Node.js. It wraps the REST API with:

- Event-driven TTS lifecycle (`start`, `ttfb`, `progress`, `complete`, `error`)
- Retry with exponential backoff for network failures
- Typed error classes (`VoiceNotFoundError`, `EngineError`, `RateLimitError`)
- Format-aware audio playback
- Optional voice cache with TTL
- Debug logging with request IDs

```javascript
import { NSpeechClient } from './lib/nspeech-client/nspeech-client-v2.js';

const nspeech = new NSpeechClient({
  baseUrl: 'http://127.0.0.1:2233',
  debug: true
});

// Streaming TTS with events
const stream = nspeech.speechStream({
  model: 'kokoro',
  input: 'Hello world.',
  voice: 'af_heart'
});

stream.on('ttfb', ({ timeMs }) => console.log(`First audio: ${timeMs}ms`));
stream.on('complete', ({ audioUrl, durationMs }) => {
  console.log(`Done in ${durationMs}ms`);
  audio.src = audioUrl;  // play it
});
stream.on('error', (err) => console.error(err.name, err.message));

// Convenience: fetch an audio blob and play
const blob = await nspeech.speak({
  model: 'kokoro',
  input: 'Quick one-shot.',
  voice: 'af_heart'
});
```

### Basic TTS (raw API)

```javascript
const response = await fetch('http://127.0.0.1:2233/v1/audio/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'kokoro',           // or 'minimax', 'elevenlabs', 'gemini', 'xai'
    input: 'Hello world.',
    voice: 'af_heart',
    response_format: 'mp3'
  })
});

const audioBlob = await response.blob();
```

### Streaming

```javascript
const response = await fetch('http://127.0.0.1:2233/v1/audio/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'kokoro',
    input: 'Long text here...',
    voice: 'af_heart',
    response_format: 'mp3'
  })
});

const reader = response.body.getReader();
// Pipe to MediaSource Extensions or save incrementally
```

### Engine-Specific Tuning

Pass `extra_body` for engine-specific options. Unsupported fields are silently ignored.

```javascript
{
  model: 'elevenlabs',
  input: 'Dramatic reading.',
  voice: 'my_narrator',
  extra_body: {
    stability: 0.3,
    expressiveness: 0.8
  }
}
```

See [documentation/API_REFERENCE.md](documentation/API_REFERENCE.md) for the full `extra_body` field support matrix.

### Voice Blending (Per-Request)

Blend up to 4 voices on the fly without saving:

```javascript
{
  model: 'kokoro',
  input: 'Blended voice test.',
  extra_body: {
    blend: [
      { voice_id: 'af_heart', weight: 30 },
      { voice_id: 'af_bella', weight: 70 }
    ]
  }
}
```

## Admin UI

The dashboard at `http://127.0.0.1:2233/` is the **admin interface** for:

- Creating cloned voices from reference audio
- Creating voice presets (saved voice + instructions + settings)
- Switching the active local engine
- Testing generation across all engines

Clients do not need the dashboard — they use the API directly.

## Documentation

| Document | Purpose |
|----------|---------|
| [documentation/API_REFERENCE.md](documentation/API_REFERENCE.md) | Concise endpoint reference with examples |
| [docs/AUDIO_API_PLAN.md](docs/AUDIO_API_PLAN.md) | Canonical API contract and `extra_body` schema |
| [nSpeech_Spec.md](nSpeech_Spec.md) | Full technical specification (for developers/LLMs) |
| [Agents.md](Agents.md) | Project aims and activity log |

## Engine Support

| Engine | Type | Voices | Cloning | Notes |
|--------|------|--------|---------|-------|
| **Kokoro** | Local | 54 built-in | Stub | Fast, reliable, always available |
| **Chatterbox Turbo** | Local | Clone-only | Zero-shot | Best local quality, ~2GB VRAM |
| **MiniMax** | Cloud | 332+ | Instant API | High quality, expressive |
| **ElevenLabs** | Cloud | 10,000+ | Professional | Premium quality |
| **Gemini** | Cloud | 30 system | — | Instruction-driven style |
| **xAI** | Cloud | System | — | Alternative cloud option |

## Requirements

- **Node.js** ≥ 22
- **Python** 3.10+ (for local engines)
- **GPU** optional but recommended for local engines (CUDA)
- **ffmpeg** bundled via `lib/nvideo` submodule

## License

Private — herrbasan

