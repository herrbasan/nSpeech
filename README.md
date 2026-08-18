# nSpeech

Multi-engine Text-to-Speech **and Speech-to-Text** with a unified OpenAI-compatible API. Run local GPU models (Kokoro, Chatterbox) and cloud providers (MiniMax, ElevenLabs, Gemini, xAI) behind one simple HTTP interface — plus local CPU transcription (faster-whisper) and text-constrained forced alignment (MMS CTC).

## What You Get

- **One API** — OpenAI-compatible `POST /v1/audio/speech` for all engines
- **Multiple engines** — local (Kokoro, Chatterbox Turbo) + cloud (MiniMax, ElevenLabs, Gemini, xAI)
- **Voice library** — native system voices, cloned voices, and saved presets
- **Streaming** — real-time PCM → MP3/Opus/AAC via ffmpeg
- **Long-form stitching** — texts beyond engine limits are chunked and seamlessly stitched (`extra_body.mode:'stitch'`: spoken overlap + forced-alignment trim)
- **Transcription** — `POST /v1/audio/transcriptions` (faster-whisper large-v3, CPU, word timestamps)
- **Forced alignment** — `POST /v1/audio/align` (MMS CTC — constrained to your text, word count guaranteed, DE/EN + 1100 languages)
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

### 4. Transcribe Audio

```bash
curl -X POST http://127.0.0.1:2233/v1/audio/transcriptions \
  -F "file=@audio.wav" \
  -F "word_timestamps=true"
```

Local CPU (faster-whisper large-v3 int8). First call spawns the STT worker; subsequent calls are warm. If you already know the text, `POST /v1/audio/align` pins it to the audio with guaranteed word correspondence (used internally for seamless chunk stitching).

## Integration

### SDK (Recommended)

The nSpeech Client SDK (`lib/nspeech-client/nspeech-client.js`) is a single-file, zero-dependency ESM module for browser and Node.js. Four exports cover the whole surface:

- **`NSpeechClient`** — REST API: `speech()` (with `clean:true` for client-side markdown cleaning), `speechStream()` (event-driven lifecycle: `start`, `ttfb`, `progress`, `complete`, `error`), voices, cloning, presets, engine admin. Retry with exponential backoff, typed errors (`VoiceNotFoundError`, `EngineError`, `RateLimitError`), voice cache with TTL.
- **`SpeechPlayer`** — streaming playback (browser): decoupled download/playback (pause never aborts the stream), MSE with blob fallback, seek/pause/resume, `state`/`time`/`download-progress` events.
- **`EventStream`** — `/v1/admin/events` SSE feed with auto-reconnect; `progress` events carry chunking `stage`/`percent`.
- **`cleanMarkdown`** / **`expandAcronyms`** — the canonical markdown→speech cleaner (same code the server uses).

```javascript
import { NSpeechClient, SpeechPlayer, EventStream } from './lib/nspeech-client/nspeech-client.js';

const nspeech = new NSpeechClient({ baseUrl: 'http://127.0.0.1:2233', debug: true });

// Streaming TTS with events + client-side markdown cleaning
const stream = nspeech.speechStream({ model: 'nspeech', input: markdown, voice: 'af_heart', clean: true });
stream.on('ttfb', ({ timeMs }) => console.log(`First audio: ${timeMs}ms`));
stream.on('complete', ({ audioUrl }) => { audio.src = audioUrl; });

// Or: full playback control (pause/seek, progressive buffering)
const player = new SpeechPlayer({ client: nspeech });
player.on('state', ({ state }) => console.log(state));
player.speak({ model: 'nspeech', input: markdown, voice: 'af_heart', clean: true });

// Server-side job progress (chunking stage + percent)
const events = new EventStream({ baseUrl: 'http://127.0.0.1:2233', types: ['tts'] });
events.on('progress', ({ percent, stage }) => console.log(stage, percent));
events.connect();
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

### Markdown Input

Clean markdown to speech-ready text **client-side** before sending — the canonical cleaner ships in the SDK (`lib/nspeech-client/nspeech-client.js`):

```javascript
import { cleanMarkdown } from './lib/nspeech-client/nspeech-client.js';

const body = { model: 'nspeech', input: cleanMarkdown(articleMarkdown), voice: 'af_heart' };
// Or simply: nspeech.speech({ model: 'nspeech', input: articleMarkdown, voice: 'af_heart', clean: true })
```
Rules settled by ear tests on F5-TTS: emphasis strips silently (engines emphasize better unmarked), label colons merge with em-dash, clause colons split into full sentence breaks, headers get terminal periods, strikethrough drops, acronyms spell out. A server-side fallback (`extra_body.markdown: true`) exists for non-migrated clients; the LLM prosody variant (`'llm'`) is parked.

### Long Texts (Seamless Stitching)

When text exceeds the engine's char limit, choose the join quality with `extra_body.mode`:

```javascript
{
  model: 'elevenlabs',
  input: '<a full article...>',
  voice: 'my_narrator',
  extra_body: { mode: 'stitch' }   // seamless joins; default 'stream' is fast but has audible seams
}
```

`stitch` renders each chunk with the previous chunk's last paragraph as spoken overlap, locates the boundary via local forced alignment (CPU, no external service), trims at the zero-crossing nearest the word boundary, and fades both sides. Progress events (percent + stage) stream on `/v1/admin/events` (SSE).

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
| **STT worker** | Local (CPU) | — | — | faster-whisper v3 + MMS alignment; internal engine `stt`, never evicted by TTS switching |

## Requirements

- **Node.js** ≥ 22
- **Python** 3.10+ (for local engines)
- **GPU** optional but recommended for local engines (CUDA)
- **ffmpeg** bundled via `lib/nvideo` submodule

## License

Private — herrbasan

