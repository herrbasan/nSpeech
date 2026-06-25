# nSpeech Unified Audio API Plan

**Version: 3.0.0** (branch `v3.0.0`)  
Status: draft  
Date: 2026-06-25  
Goal: define an OpenAI-compatible audio surface for nSpeech that also covers local-only features (cloning, blending, forced alignment) and can host cloud-provider adapters.

## 1. Guiding principle

Clients always speak one API. The backend translates that API into engine-specific calls, whether the engine is local (Kokoro, CosyVoice, dots.tts) or remote (OpenAI, ElevenLabs, Azure, Google).

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
  "model": "kokoro",
  "input": "Hello world.",
  "voice": "af_heart",
  "response_format": "pcm",
  "speed": 1.0,
  "instructions": "Speak clearly and warmly.",
  "extra_body": {
    "offline": false,
    "exaggeration": 0.5,
    "steps": 4,
    "guidance_scale": 1.2,
    "blend": ["af_heart", "af_bella:0.7"]
  }
}
```

### Standard OpenAI fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Engine/model selector. Examples: `kokoro`, `cosyvoice_0.5b`, `dots_mf`, `openai_tts_1`, `elevenlabs_turbo_v2_5`. |
| `input` | string | Text to speak. Max length engine-specific. |
| `voice` | string | Voice ID. May be a built-in voice, a persisted cloned voice, or an engine-specific alias. |
| `response_format` | string | `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`. Default `mp3`. |
| `speed` | float | Speaking speed. OpenAI range `0.25`–`4.0`. Engines may clamp. |
| `instructions` | string | Natural-language style directions. Passed through when the engine supports it. |

### nSpeech extensions in `extra_body`

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `offline` | boolean | local engines | `true` = buffer and validate full audio before responding; `false` = stream chunks as generated. |
| `exaggeration` | float | some engines | Chatterbox-style expressiveness. |
| `steps` | int | AR engines | Diffusion/flow NFE steps, e.g. dots.tts. |
| `guidance_scale` | float | some engines | Classifier-free guidance. |
| `blend` | array of strings | Kokoro | Voice blending recipe, e.g. `["af_heart", "af_bella:0.7"]`. |
| `language` | string | multilingual engines | ISO-639-1 hint, e.g. `de`, `zh`. |
| `text_frontend` | boolean | CosyVoice | Enable/disable internal text normalization. Default `false`. |
| `emotion_tags` | boolean | CosyVoice | Allow inline tags like `<|sad|>`, `[breath]`. |

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
model: dots_mf
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
in CosyVoice. Requesting `model: cosyvoice_0.5b, voice: af_heart` returns a `voice_not_found`
error, not a silent fallback to a default voice. Silent fallback hides bugs.

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

Each cloud TTS/STT provider is implemented as an adapter in `src/nspeech/engines/<provider>.py`, just like a local engine.

The adapter must implement the same duck-typed interface:

```python
class CloudProviderAdapter:
    def generate(self, text: str, **kwargs):
        """Yield (pcm_bytes_or_tensor, is_final) tuples."""

    def transcribe(self, audio_bytes: bytes, **kwargs) -> dict:
        """Return OpenAI-shaped verbose_json result."""

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> dict:
        """Persist or return a voice ID."""

    def list_voices(self) -> list:
        """Return voice catalog."""
```

Cloud adapters are responsible for:
- Mapping `model` and `voice` to provider-native IDs.
- Converting output audio to the nSpeech PCM contract.
- Translating provider-native options from `extra_body`.
- Handling provider authentication via environment variables (e.g. `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`).

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
    "message": "Voice 'af_heart' not found in engine cosyvoice_0.5b",
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

## 11. Open questions / next steps

1. Research cloud TTS provider option sets (OpenAI, ElevenLabs, Azure, Google, Amazon, PlayHT, Cartesia) to confirm `extra_body` can express their key parameters.
2. Decide whether STT should be a separate nVoice service or merged into nSpeech.
3. ~~Define error code mapping to OpenAI-compatible `error` objects.~~ → Done, see §10.
4. ~~Decide `pcm` default: OpenAI 16-bit LE or nSpeech native float32.~~ → Decided: `pcm` is OpenAI 16-bit LE; `pcm_f32` is the native opt-in.
