# nSpeech API Reference

nSpeech provides HTTP REST and WebSocket APIs for TTS generation, voice cloning,
and management. An OpenAI-proxy endpoint is also available.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status |
| GET | `/engine` | Active engine name |
| GET | `/voices` | List all voices (cloned, builtin, previews) |
| POST | `/voices/clone` | Clone a voice from reference audio |
| POST | `/voices/preview` | Preview a voice without saving |
| DELETE | `/voices/{name}` | Delete a cloned or preview voice |
| POST | `/voices/mix` | Blend two Kokoro voices (Kokoro only) |
| GET | `/tts` | Streaming synthesis (GET, for `<audio>` src) |
| POST | `/tts` | Streaming synthesis (POST) |
| GET | `/docs` | API reference (rendered via nui-markdown) |
| GET | `/api-docs.md` | API reference (raw markdown) |
| POST | `/v1/audio/speech` | OpenAI-compatible proxy |

---

## 1. Health & Info

### GET /health
```json
{"status": "ok", "default_engine": "chatterbox"}
```

### GET /engine
```json
{"engine": "chatterbox"}
```

---

## 2. Voice Management

### GET /voices
Returns all voices: cloned (`.wav` + cache), builtin (Kokoro), previews, and standalone
caches.

```json
{
  "voices": [
    {"name": "Allan", "source_file": "Allan.wav", "voice_type": "cloned",
     "engines": [{"name": "chatterbox", "cached": true}]},
    {"name": "af_heart", "source_file": "builtin", "voice_type": "builtin",
     "engines": [{"name": "kokoro", "cached": true, "latency_tier": "fast"}]}
  ]
}
```

### POST /voices/clone
**Form data**: `file` (.wav), `name` (string), `engine` (optional), `model` (optional), `exaggeration` (float, default 0.5)

```json
{
  "voice_name": "my_voice",
  "engine": "chatterbox",
  "cache_file": "venv/chatterbox/voices/my_voice.chatterbox.pt",
  "clone_time_ms": 570
}
```

### POST /voices/preview
**Form data**: `file` (.wav), `test_phrase` (optional), `engine` (optional), `model` (optional)

Returns: streaming MP3 audio of the test phrase using the uploaded voice (not saved to
permanent cache).

### DELETE /voices/{name}
Deletes the `.wav`, `.pt` cache files, and in-memory spk2info entry for the named voice.

```json
{"deleted": ["my_voice.wav", "my_voice.chatterbox.pt"]}
```

### POST /voices/mix (Kokoro only)
**JSON body**:
```json
{"name": "my_blend", "voice_a": "af_heart", "voice_b": "af_bella", "ratio": 0.5}
```

---

## 3. Text-to-Speech

### GET /tts (simplified, for `<audio src="...">`)
**Query params**: `text` (required), `voice_name`, `output_format`, `engine`, `model`,
`language`, `instruct_text`, `speed`, `exaggeration`

### POST /tts
**JSON body**:
```json
{
  "text": "Hello world.",
  "voice_name": "Allan",
  "engine": "chatterbox",
  "model": "turbo",
  "language": "en",
  "instruct_text": null,
  "speed": 1.0,
  "exaggeration": 0.5,
  "output_format": "mp3",
  "transcode_sample_rate": 24000,
  "transcode_bitrate": "128k"
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `text` | string | *required* | Text to synthesize |
| `voice_name` | string | `"default"` | Voice to use (cloned name or "default") |
| `engine` | string | env `NSPEECH_ENGINE` | Engine override |
| `model` | string | `null` | Chatterbox model: `turbo`, `eng`, `mtl` |
| `language` | string | `null` | Language code (de, fr, ja, etc.) |
| `instruct_text` | string | `null` | Emotion/style instruction (CosyVoice) |
| `speed` | float | `1.0` | Playback speed (CosyVoice, pitch-safe) |
| `exaggeration` | float | `0.5` | Expression emphasis (Chatterbox, Kokoro) |
| `output_format` | string | `"wav"` | `wav`, `mp3`, `pcm`, `ogg`, `webm` |
| `transcode_sample_rate` | int | `24000` | Output sample rate |
| `transcode_bitrate` | string | `"128k"` | Codec bitrate |

**Response**: Streaming binary audio (`Transfer-Encoding: chunked`).

---

## 4. WebSocket (WS /ws/tts)

Client sends JSON, server streams binary frames + final JSON `{"is_final": true}`.

**Client → Server**:
```json
{
  "text": "Hello world.",
  "voice_name": "Allan",
  "engine": "chatterbox",
  "model": "turbo",
  "output_format": "mp3",
  "exaggeration": 0.5,
  "speed": 1.0,
  "transcode_sample_rate": 24000,
  "transcode_bitrate": "128k"
}
```

---

## 5. OpenAI Proxy (POST /v1/audio/speech)

```json
{
  "model": "chatterbox",
  "input": "Hello world.",
  "voice": "Allan",
  "response_format": "mp3",
  "speed": 1.0
}
```

Maps `model` → `engine`, `voice` → `voice_name`, `response_format` → `output_format`.
`speed` mapped to exaggeration inversely.

---

## 6. Environment Variables

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `NSPEECH_ENGINE` | — | **Yes** | Engine: `kokoro`, `cosyvoice`, `chatterbox` |
| `NSPEECH_VOICE_DIR` | — | **Yes** | Voice cache directory |
| `NSPEECH_MODEL_DIR` | — | **Yes** | Model weights directory |
| `NSPEECH_HOST` | `127.0.0.1` | No | Bind address |
| `NSPEECH_PORT` | `8000` | No | Bind port |
| `NSPEECH_API_KEY` | `""` | No | Auth token (unused) |
| `NSPEECH_PRELOAD_MODEL` | `false` | No | Preload engine on startup |
| `NSPEECH_MODEL_IDLE_TIMEOUT_SEC` | `0` | No | LRU eviction timeout |
| `NSPEECH_LOG_LEVEL` | `INFO` | No | Log level |
| `NSPEECH_LOG_DIR` | `logs` | No | Log output directory |
| `NSPEECH_TRANSCODE_SAMPLE_RATE` | `24000` | No | Default output sample rate |
| `NSPEECH_TRANSCODE_BITRATE` | `128k` | No | Default codec bitrate |

---

## 7. Documentation Endpoints

### GET /docs
Renders `API_REFERENCE.md` as a styled HTML page using the `nui-markdown` component.
Accessible via the "Docs" link in the dashboard sidebar.

### GET /api-docs.md
Returns the raw `API_REFERENCE.md` as `text/markdown`.

**Response:** Raw Markdown content of this document.
