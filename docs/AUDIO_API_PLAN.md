# nSpeech Unified Audio API Plan

**Version: 3.0.0** (branch `v3.0.0`)  
Status: draft  
Date: 2026-06-25  
Goal: define an OpenAI-compatible audio surface for nSpeech that also covers local-only features (cloning, blending, forced alignment) and can host cloud-provider adapters.

## 1. Guiding principle

Clients always speak one API. The backend translates that API into engine-specific calls, whether the engine is local (Kokoro, dots.tts) or remote (OpenAI, ElevenLabs, Azure, Google).

- Base shape follows the OpenAI audio endpoints where possible.
- Local-only features live in the same JSON body via `extra_body` (for structured options) or in separate multipart endpoints (for file uploads).
- The API is hosted by nSpeech. The LLM Gateway can proxy/auth/route to it, but it does not need to re-implement audio-domain logic.

## 2. Endpoint surface

| Method | Path | Purpose | Spec source |
|--------|------|---------|-------------|
| `POST` | `/v1/audio/speech` | Text-to-speech | OpenAI `/audio/speech` |
| `POST` | `/v1/audio/speech/clone` | One-shot TTS from an uploaded voice sample | nSpeech extension |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text | OpenAI `/audio/transcriptions` |
| `POST` | `/v1/audio/align` | Forced alignment: audio + known text → word timestamps | nSpeech extension |
| `GET`  | `/v1/voices` | List available voices | nSpeech extension |
| `POST` | `/v1/voices/clone` | Persist a cloned voice | nSpeech extension |
| `POST` | `/v1/voices/preview` | Clone to a temporary voice (no persistence) | nSpeech extension |
| `POST` | `/v1/voices/mix` | Blend two voices (Kokoro) | nSpeech extension |
| `DELETE` | `/v1/voices/{voice_id}` | Delete a saved voice | nSpeech extension |

## 3. TTS — `/v1/audio/speech`

### Request body (JSON)

```json
{
  "model": "nspeech",
  "input": "Hello world.",
  "voice": "af_heart",
  "response_format": "pcm",
  "speed": 1.0,
  "instructions": "Speak clearly and warmly.",
  "extra_body": {
    "pitch": 2,
    "emotion": "happy",
    "expressiveness": 0.7,
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

### Standard OpenAI fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Engine/provider selector. **Public values:** `"nspeech"` (dashboard-selected local engine), `"minimax"`, `"elevenlabs"`, `"gemini"`, `"xai"`. Cloud sub-models use underscores: `"minimax_speech_2_8_hd"`, `"elevenlabs_turbo_v2_5"`. Local engine names (`kokoro`, `dots`, etc.) are internal — use `"nspeech"` and switch via dashboard/`POST /v1/admin/engine`. |
| `input` | string | Text to speak. Max length engine-specific. |
| `voice` | string | Voice ID. May be a built-in voice, a persisted cloned voice, or an engine-specific alias. |
| `response_format` | string | `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`. Default `mp3`. |
| `speed` | float | Speaking speed. OpenAI range `0.25`–`4.0`. Engines may clamp. |
| `instructions` | string | Natural-language style directions. Passed through when the engine supports it. |

### nSpeech extensions in `extra_body`

All fields are **optional**. Engines ignore unsupported fields silently. This is
a "if you support it, use it; if not, pass" contract. Providers that support a
given feature read it from `extra_body`; providers that don't, don't.

Fields are organized by category so future providers (ElevenLabs, Azure, Google,
PlayHT, Cartesia) can find natural homes for their features.

```json
{
  "extra_body": {
    "pitch": 0,
    "emotion": "calm",
    "expressiveness": 0.5,
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
    "sound_effects": "spacious_echo"
  }
}
```

#### Voice Character

| Field | Type | Range | Default | Description |
|-------|------|-------|---------|-------------|
| `pitch` | number | -12..12 | 0 | Semitone pitch shift. -12 = deeper, +12 = brighter. |
| `emotion` | string | enum | — | `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `calm`, `whisper`, `fluent`. |
| `expressiveness` | number | 0..1 | 0.5 | Delivery intensity. 0 = flat/monotone, 1 = highly dramatic/stylized. |
| `stability` | number | 0..1 | 0.5 | Voice consistency. 0 = variable/prosodic, 1 = steady/monotone. Inverse of variation. |

#### Quality / Generation Control

| Field | Type | Range | Default | Description |
|-------|------|-------|---------|-------------|
| `inference_steps` | int | 1..32 | 4 | Diffusion/flow NFE. More steps = higher quality, slower generation. |
| `guidance_scale` | number | 0..3 | 1.2 | Voice reference adherence. Higher = stick closer to the voice clone. |
| `seed` | int | any | — | Random seed. Same seed + same input = reproducible output. |
| `batch` | boolean | — | false | `true` = render full audio before first byte. `false` = stream progressively. Formerly `offline`. |

#### Model Selection

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Provider sub-model variant. e.g. `speech-2.8-turbo` (MiniMax), `eleven_turbo_v2_5` (ElevenLabs). For local engines, sub-model selection is engine-specific (e.g. Chatterbox `turbo`/`eng`/`mtl`, dots checkpoint). Overrides the top-level `model` field for sub-model selection. |

#### Voice Blending

| Field | Type | Description |
|-------|------|-------------|
| `blend` | array | Up to 4 `{voice_id, weight}` pairs. Weight: 1..100. Higher weight = more of that voice's character. When present, the top-level `voice` field is ignored. |

#### Text Processing

| Field | Type | Description |
|-------|------|-------------|
| `pronunciation` | object | `{tone: ["original/replacement"]}`. Replacement can be IPA, pinyin, jyutping, kana, or plain text. |
| `ssml` | boolean | Interpret `input` as SSML markup. Providers that don't support SSML strip tags and read the text. |
| `language` | string | ISO-639-1 language hint. `auto` for automatic detection. |

#### Audio Output

| Field | Type | Range | Default | Description |
|-------|------|-------|---------|-------------|
| `sample_rate` | int | 8000..44100 | engine-default | Audio sample rate in Hz. |
| `channel` | int | 1, 2 | 1 | Mono or stereo output. |
| `bitrate` | int | 32000..256000 | — | Encoded bitrate. Only used with `mp3` format. |

#### Effects

| Field | Type | Description |
|-------|------|-------------|
| `sound_effects` | string | `spacious_echo`, `auditorium_echo`, `lofi_telephone`, `robotic`. One at a time. |

### Engine support matrix

The `nspeech` column represents whichever local engine the dashboard has selected (kokoro, chatterbox, or dots). Cloud providers are listed individually.

| Field | nspeech (local) | MiniMax | ElevenLabs | Gemini | xAI |
|-------|-----------------|---------|------------|--------|-----|
| `pitch` | — | ✅ `voice_setting.pitch` | — | — | — |
| `emotion` | engine-dependent | ✅ `voice_setting.emotion` | — | — | — |
| `expressiveness` | engine-dependent | emotion map | `style_exaggeration` | — | — |
| `stability` | — | — | ✅ `stability` | — | — |
| `inference_steps` | dots only | — | — | — | — |
| `guidance_scale` | dots only | — | `similarity_boost` | — | — |
| `seed` | dots only | — | `seed` | — | — |
| `batch` | engine-dependent | ✅ | ✅ | ✅ | ✅ |
| `model` | engine-dependent | ✅ maps to request `model` | model slug | — | — |
| `blend` | kokoro only (mix endpoint) | ✅ `timbre_weights` | — | — | — |
| `pronunciation` | — | ✅ `pronunciation_dict` | — | — | — |
| `language` | engine-dependent | ✅ `language_boost` | `language_code` | ✅ (auto) | — |
| `sample_rate` | — (fixed 24k) | ✅ `audio_setting.sample_rate` | `output_format.sample_rate` | — | — |
| `channel` | — (fixed mono) | ✅ `audio_setting.channel` | — | — | — |
| `bitrate` | — | ✅ `audio_setting.bitrate` | — | — | — |
| `sound_effects` | — | ✅ `voice_modify.sound_effects` | — | — | — |

### Response

Returns raw audio bytes with the appropriate `Content-Type`.

| `response_format` | Content-Type |
|-------------------|--------------|
| `mp3` | `audio/mpeg` |
| `opus` | `audio/opus` |
| `aac` | `audio/aac` |
| `flac` | `audio/flac` |
| `wav` | `audio/wav` |
| `pcm` | `audio/pcm` (nSpeech native) or `application/octet-stream` (OpenAI-compatible) |

### PCM format

- `response_format: pcm` → OpenAI spec: 24 kHz, 16-bit signed little-endian, mono. This is the default and what OpenAI clients expect.
- `response_format: pcm_f32` → nSpeech native: 24 kHz, float32, mono. Internal clients (dashboard, Arena Slides) use this to skip a conversion.
- The adapter normalizes to the requested contract.

### Streaming

OpenAI-compatible streaming is requested with `stream: true`.

- Local engines that already yield PCM chunks stream each chunk as it is generated.
- Cloud adapters that return complete files buffer and stream chunks of a fixed byte size.
- Each chunk is a raw audio fragment; no SSE or JSON wrapper.
- **Streaming mode header:** every streaming response includes `X-Stream-Mode: native`
  (real incremental generation, local engines) or `X-Stream-Mode: chunked` (complete
  file sliced into chunks, cloud adapters or `offline: true`). Clients that need true
  low-latency incremental delivery should check this header.
- **Streaming is best-effort and non-resumable.** If the connection breaks mid-stream
  (worker crash, engine switch, client disconnect), the client receives a partial
  response. There is no resume or offset mechanism. Clients must re-request from scratch.

## 4. One-shot TTS from reference — `/v1/audio/speech/clone`

Clones a voice from an uploaded audio sample and immediately synthesizes text in that voice. The voice is **not persisted**.

### Request body (multipart/form-data)

```http
POST /v1/audio/speech/clone
Content-Type: multipart/form-data

input: Hello world
model: nspeech
response_format: pcm
audio: <binary wav/mp3>
prompt_text: Hello world        # optional transcript
extra_body[steps]: 4
extra_body[guidance_scale]: 1.2
```

### Fields

All standard TTS fields apply, plus:

| Field | Type | Description |
|-------|------|-------------|
| `audio` | file | Reference audio sample. Format auto-detected; MP3/WAV/OGG accepted. |
| `prompt_text` | string | Optional transcript of the reference audio. Improves cloning fidelity when the engine supports it. |

### Response

Same as `/v1/audio/speech`: raw audio bytes.

### Implementation note

The server can implement this as `clone_to_temp_voice(audio, prompt_text) → generate(input, temp_voice_id)`. For cloud providers that support one-shot voice cloning, the adapter maps the same multipart shape to the provider’s native call.

## 5. STT — `/v1/audio/transcriptions`

### Request body (multipart/form-data)

```http
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: <binary audio>
model: nvoice_whisper
language: en
prompt: This is a technical conversation.
response_format: verbose_json
temperature: 0
```

### Standard OpenAI fields

| Field | Type | Description |
|-------|------|-------------|
| `file` | file | Audio file to transcribe. |
| `model` | string | STT model/adapter selector. Examples: `nvoice_whisper`, `openai_whisper_1`, `azure_speech`. |
| `language` | string | ISO-639-1 language hint. |
| `prompt` | string | Optional context/prompt. |
| `response_format` | string | `json`, `text`, `srt`, `verbose_json`, `vtt`. Default `json`. |
| `temperature` | float | Sampling temperature. |
| `timestamp_granularities[]` | string | `word` or `segment`. Only honored for `verbose_json`. |

### nSpeech extensions in `extra_body`

| Field | Type | Description |
|-------|------|-------------|
| `context_text` | string | Known transcript. If provided, nVoice can align instead of pure transcribe. |
| `align` | boolean | `true` = return timestamps for `context_text` words rather than free transcription. |

### Response

#### `json`

```json
{
  "text": "Hello world."
}
```

#### `verbose_json` with `timestamp_granularities: ["word"]`

```json
{
  "task": "transcribe",
  "language": "en",
  "duration": 2.5,
  "text": "Hello world.",
  "words": [
    {"word": "Hello", "start": 0.12, "end": 0.58},
    {"word": "world", "start": 0.62, "end": 1.05}
  ]
}
```

## 6. Forced alignment — `/v1/audio/align`

This is not in the OpenAI spec. It takes an audio file and the exact text that was spoken, then returns per-word timestamps for that text.

### Request body (multipart/form-data)

```http
POST /v1/audio/align
Content-Type: multipart/form-data

file: <binary audio>
text: Hello world.
model: nvoice
language: en
```

### Response

```json
{
  "text": "Hello world.",
  "duration": 2.5,
  "words": [
    {"word": "Hello", "start": 0.12, "end": 0.58},
    {"word": "world", "start": 0.62, "end": 1.05}
  ]
}
```

## 7. Voice management — `/v1/voices`

### Voice ID namespacing

Voice IDs are **engine-scoped**. A voice `af_heart` exists in Kokoro; it does not exist
in dots.tts. If the dashboard has dots selected and you request
`model: nspeech, voice: af_heart`, you get a `voice_not_found` error — not a silent
fallback. Silent fallback hides bugs.

A cloned voice `my_voice` persisted in Kokoro's cache is not visible to dots.tts. To use
the same reference audio across engines, clone it separately in each engine.

The `engine` field in voice listings (see below) makes the scope explicit. Clients must
not assume a voice ID is portable across engines.

### `GET /v1/voices`

List built-in, cloned, and blended voices available for the current engine.

```json
{
  "voices": [
    {
      "voice_id": "af_heart",
      "name": "af_heart",
      "category": "builtin",
      "preview_url": null,
      "engine": "kokoro"
    },
    {
      "voice_id": "my_voice",
      "name": "my_voice",
      "category": "cloned",
      "preview_url": null,
      "engine": "dots"
    }
  ]
}
```

### `POST /v1/voices/clone` (persistent)

```http
POST /v1/voices/clone
Content-Type: multipart/form-data

name: my_voice
audio: <binary wav/mp3>
engine: dots_mf
prompt_text: Hello world
```

Response:

```json
{
  "voice_id": "my_voice",
  "name": "my_voice",
  "category": "cloned",
  "engine": "dots_mf",
  "created": 1735689600
}
```

### `POST /v1/voices/preview` (temporary)

Same as `/v1/voices/clone`, but the voice is not persisted. Returns a temporary `voice_id` that expires after a TTL.

### `POST /v1/voices/mix`

Blend two voices (engine-specific, currently Kokoro only).

```json
{
  "name": "my_blend",
  "voice_a": "af_heart",
  "voice_b": "am_michael",
  "ratio": 0.5
}
```

Response:

```json
{
  "voice_id": "my_blend",
  "name": "my_blend",
  "category": "blended",
  "engine": "kokoro"
}
```

### `DELETE /v1/voices/{voice_id}`

Remove a persisted cloned or blended voice.

## 8. Adapter contract for cloud providers

Cloud providers run **directly in Node** as fetch-based modules under `server/cloud/`. No Python venv, no child process, no GPU.

Each cloud adapter implements this contract (same duck-typed surface as `WorkerProcess`, but without the HTTP relay — the adapter IS the implementation):

```js
class CloudAdapter {
  async generatePcmStream({ text, voice_name, speed, instruct_text, extra_body }) → Readable
  async listVoices() → [{ voice_id, name, category, engine, ... }]
  async cloneVoice({ audio, voice_name, ... }) → { voice_id, ... }
  async deleteVoice(voice_id) → { success }
  async health() → { status: 'ready' }
}
```

Cloud adapters are responsible for:
- Mapping `extra_body` fields to provider-native request parameters.
- Requesting raw PCM from the provider (or decoding hex/mpeg to PCM).
- Returning a Node `Readable` stream of `s16le 24kHz mono` PCM bytes.
- Node's existing `pipePcmToClient` handles the PCM→MP3/Opus/AAC transcode.
- Reading API keys from `.env` at startup; failing fast if missing.

The EngineManager checks the cloud registry first. If `model` matches a cloud
prefix (e.g. `minimax_*` → MiniMax adapter), it routes there. Otherwise it
falls through to a Python worker.

## 9. Gateway integration

The LLM Gateway can treat nSpeech as just another backend:

```
Client → Gateway /v1/audio/speech
              ↓
         nSpeech /v1/audio/speech
              ↓
         engine adapter (local or cloud)
```

Gateway responsibilities:
- Authentication / API key validation.
- Rate limiting / spend tracking.
- Routing (e.g. `model: openai_*` → nSpeech with OpenAI adapter).

Gateway does **not** need to:
- Know voice cache formats.
- Manage engine venvs.
- Implement per-provider audio translation.

## 10. Error responses

All errors use the OpenAI-compatible shape:

```json
{
  "error": {
    "message": "Voice 'af_heart' not found in engine dots",
    "type": "invalid_request_error",
    "code": "voice_not_found",
    "param": "voice"
  }
}
```

Common error types:

| `type` | When |
|-------|------|
| `invalid_request_error` | Bad input, unknown voice, unknown model, bad format. |
| `engine_error` | Engine failed during generation (GPU OOM, model load failure). |
| `rate_limit_exceeded` | Cloud provider rate limit hit. |
| `service_unavailable` | Worker crashed, not ready, or switching. |

HTTP status codes: 400 (invalid request), 404 (voice/model not found), 409 (engine
switch conflict), 429 (rate limit), 500 (engine error), 503 (worker unavailable).

## 11. Revision history

| Date | Change |
|------|--------|
| 2026-06-25 | Initial draft. |
| 2026-07-02 | Finalized `extra_body` schema. Renamed `exaggeration`→`expressiveness`, `steps`→`inference_steps`. Added `pitch`, `emotion`, `stability`, `pronunciation`, `ssml`, `sample_rate`, `channel`, `bitrate`, `sound_effects`. Cloud adapters moved from Python to Node. |
