# xAI / Grok Voice — Speech Provider

**Base URL:** `https://api.x.ai`  
**Auth:** `Authorization: Bearer <XAI_API_KEY>`  
**API Key source:** [xAI Console > API Keys](https://console.x.ai/team/default/api-keys)  
**Playground:** [console.x.ai/voice/text-to-speech](https://console.x.ai/team/default/voice/text-to-speech)

> xAI's TTS launched mid-2026 alongside Grok. 5 built-in voices with distinct personalities, custom voice cloning, inline speech tags (`[pause]`, `[laugh]`, `<whisper>...`), 20 languages, and a WebSocket streaming endpoint with multi-turn sessions and barge-in. Returns MP3 by default — effectively the closest thing to an "OpenAI TTS" cloud provider (same company DNA).

---

## Models

| Model | Description |
|-------|-------------|
| `grok-tts-1` | Standard quality, fast |
| `grok-tts-1-hd` | Higher fidelity, slightly slower |

**nSpeech default:** `grok-tts-1` — best latency/quality balance. Model selection is implicit via the endpoint — there is no `model` parameter in the request body.

---

## Voices

Five built-in voices, each with a distinct personality:

| Voice ID | Tone | Best for |
|----------|------|----------|
| `eve` | Energetic, upbeat | Demos, announcements, upbeat content |
| `ara` | Warm, friendly | Conversational interfaces, customer support, warm narration |
| `rex` | Confident, clear | Business presentations, corporate communications, tutorials |
| `sal` | Smooth, balanced | Versatile, mixed content types |
| `leo` | Authoritative, strong | Instructions, educational content, authoritative narration |

Voice IDs are **case-insensitive**. Custom cloned voices use a unique ID from the [Custom Voices API](https://docs.x.ai/developers/model-capabilities/audio/custom-voices).

---

## Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/tts` | POST | Sync TTS (returns raw audio bytes) |
| `/v1/tts/voices` | GET | List available voices |
| `/v1/tts` | WS | Streaming TTS (WebSocket, multi-turn + barge-in) |
| `/v1/custom-voices` | GET | List custom cloned voices |
| `/v1/custom-voices` | POST | Clone a custom voice |

---

## 1. Sync TTS — `POST /v1/tts`

Primary integration path for nSpeech. Returns raw audio bytes. Maximum 15,000 characters per request.

### Request

```json
{
  "text": "Hello! Welcome to the xAI Text to Speech API.",
  "voice_id": "eve",
  "language": "en",
  "output_format": {
    "codec": "mp3",
    "sample_rate": 24000,
    "bit_rate": 128000
  },
  "speed": 1.0,
  "optimize_streaming_latency": 0,
  "text_normalization": false,
  "with_timestamps": false
}
```

### Key Fields

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `text` | ✅ | — | Text to speak. Max 15,000 chars. Supports [speech tags](#speech-tags). |
| `voice_id` | | `eve` | Built-in (`eve`,`ara`,`rex`,`sal`,`leo`) or custom voice ID. Case-insensitive. |
| `language` | ✅ | — | BCP-47 code (e.g. `en`, `zh`, `pt-BR`) or `auto` for auto-detect. See [Languages](#supported-languages). |
| `output_format.codec` | | `mp3` | `mp3`, `wav`, `pcm`, `mulaw`, `alaw` |
| `output_format.sample_rate` | | `24000` | `8000`, `16000`, `22050`, `24000`, `44100`, `48000` |
| `output_format.bit_rate` | | `128000` | MP3 only: `32000`, `64000`, `96000`, `128000`, `192000` |
| `speed` | | `1.0` | 0.7–1.5. Below 1.0 slows, above speeds up. |
| `optimize_streaming_latency` | | `0` | 0=best quality, 1=lower TTFA, 2=lowest TTFA (more quality tradeoff) |
| `text_normalization` | | `false` | When true, expands numbers/abbreviations/symbols into spoken form. |
| `with_timestamps` | | `false` | When true, returns JSON envelope with base64 audio + per-char timestamps. |

### Output Formats

| Codec | Content-Type | nSpeech use |
|-------|-------------|-------------|
| `pcm` | `audio/pcm` | ✅ **Preferred** — s16le raw PCM. Pipe directly into `pipePcmToClient`. |
| `wav` | `audio/wav` | Alternative (WAV header — can strip or pass through) |
| `mp3` | `audio/mpeg` | Default. Requires decode→re-encode or direct passthrough. |
| `mulaw` | `audio/basic` | Telephony (G.711 μ-law) |
| `alaw` | `audio/alaw` | Telephony (G.711 A-law) |

**nSpeech integration:** request `{ "codec": "pcm", "sample_rate": 24000 }` → raw s16le Buffer → pipe into `pipePcmToClient`. Same as MiniMax and ElevenLabs. Note: unlike ElevenLabs' `?output_format=pcm_24000` query param, xAI uses a nested `output_format` object in the body.

### Response

Returns raw audio bytes with the content-type matching the requested codec. No JSON wrapper (unless `with_timestamps` is true).

Errors return JSON:
```json
{"error": {"message": "Invalid voice_id", "type": "invalid_request_error", "code": "invalid_voice_id"}}
```

### Timestamp Responses

When `with_timestamps: true`, the response is a JSON envelope instead of raw bytes:
```json
{
  "audio": "<base64-encoded audio>",
  "content_type": "audio/mpeg",
  "duration": 0.92,
  "audio_timestamps": {
    "graph_chars": ["H", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d", "."],
    "graph_times": [[0.00, 0.06], [0.06, 0.12], ...]
  }
}
```

---

## 2. Voice Management

### List voices — `GET /v1/tts/voices`

```
GET /v1/tts/voices
Authorization: Bearer <XAI_API_KEY>
```

Response:
```json
{
  "voices": [
    {"voice_id": "eve", "name": "Eve"},
    {"voice_id": "ara", "name": "Ara"},
    {"voice_id": "rex", "name": "Rex"},
    {"voice_id": "sal", "name": "Sal"},
    {"voice_id": "leo", "name": "Leo"}
  ]
}
```

Also returns custom cloned voices if any exist. Custom voices appear alongside built-in voices with their assigned voice IDs.

### List custom voices — `GET /v1/custom-voices`

```
GET /v1/custom-voices
Authorization: Bearer <XAI_API_KEY>
```

Returns all cloned voices for the team. Each voice has a `voice_id` usable in `/v1/tts`.

### Clone a voice — `POST /v1/custom-voices`

Multipart upload:
```
POST /v1/custom-voices
Content-Type: multipart/form-data

name: my_voice
file: <binary wav/mp3>
```

Voice cloning is handled through a separate endpoint from TTS generation. The returned `voice_id` is then usable in `/v1/tts` requests.

---

## 3. Streaming TTS — WebSocket (`wss://api.x.ai/v1/tts`)

WebSocket streaming with multi-turn sessions, barge-in cancellation, and no text length limit.

### Connection

```
GET /v1/tts?language=en&voice=eve&codec=mp3&sample_rate=24000
Upgrade: websocket
Authorization: Bearer <XAI_API_KEY>
```

| Query Param | Required | Default | Notes |
|-------------|----------|---------|-------|
| `language` | ✅ | — | BCP-47 or `auto` |
| `voice` | | `eve` | Voice ID |
| `codec` | | `mp3` | `mp3`, `wav`, `pcm`, `mulaw`/`ulaw`, `alaw` |
| `sample_rate` | | `24000` | 8000–48000 |
| `bit_rate` | | `128000` | MP3 only, 32000–192000 |
| `speed` | | `1.0` | 0.7–1.5 |
| `optimize_streaming_latency` | | `0` | 0/1/2 |
| `text_normalization` | | `false` | true/false |
| `with_timestamps` | | `false` | true/false |

### Client → Server Messages

```json
{"type": "text.delta", "delta": "Here is some text. "}
{"type": "text.delta", "delta": "More text follows."}
{"type": "text.done"}
```

| Event | Purpose |
|-------|---------|
| `text.delta` | Text chunk (max 15,000 chars per delta) |
| `text.done` | End of utterance — server finishes and sends `audio.done` |
| `text.clear` | Cancel current utterance (barge-in) — server responds with `audio.clear` |

### Server → Client Messages

```json
{"type": "audio.delta", "delta": "<base64-encoded audio bytes>"}
{"type": "audio.done", "trace_id": "uuid"}
{"type": "audio.clear"}
{"type": "error", "message": "description"}
```

### Multi-turn

Connection stays open after `audio.done`. Send another `text.delta`→`text.done` sequence without reconnecting. 50 concurrent sessions per team. Session permit TTL: 600 seconds.

### Barge-in

Send `text.clear` mid-stream to cancel and start a new utterance on the same connection. No reconnection needed — eliminates WebSocket handshake latency on interruptions.

---

## Supported Languages

20 languages via BCP-47 codes. Use `auto` for automatic detection.

| Language | Code |
|----------|------|
| Auto-detect | `auto` |
| English | `en` |
| Arabic (Egypt) | `ar-EG` |
| Arabic (Saudi Arabia) | `ar-SA` |
| Arabic (UAE) | `ar-AE` |
| Bengali | `bn` |
| Chinese (Simplified) | `zh` |
| French | `fr` |
| German | `de` |
| Hindi | `hi` |
| Indonesian | `id` |
| Italian | `it` |
| Japanese | `ja` |
| Korean | `ko` |
| Portuguese (Brazil) | `pt-BR` |
| Portuguese (Portugal) | `pt-PT` |
| Russian | `ru` |
| Spanish (Mexico) | `es-MX` |
| Spanish (Spain) | `es-ES` |
| Turkish | `tr` |
| Vietnamese | `vi` |

The model can also generate speech in additional languages with varying accuracy.

---

## Speech Tags

xAI supports inline and wrapping speech tags for fine-grained delivery control. Tags are embedded directly in the `text` field.

### Inline Tags

Place where the expression should occur:

| Tag | Effect |
|-----|--------|
| `[pause]` | Short pause |
| `[long-pause]` | Extended pause |
| `[laugh]` | Laughter |
| `[cry]` | Crying |
| `[sigh]` | Sigh |
| `[breathe]` | Audible breath |
| `[sniffle]` | Sniffle |
| `[clear-throat]` | Throat clearing |

### Wrapping Tags

Wrap text to change delivery style:

| Tag | Effect |
|-----|--------|
| `<whisper>text</whisper>` | Whispered delivery |
| `<shout>text</shout>` | Loud, intense delivery |
| `<soft>text</soft>` | Soft, gentle delivery |
| `<slow>text</slow>` | Slower pace |
| `<fast>text</fast>` | Faster pace |
| `<sing>text</sing>` | Sung delivery |
| `<low>text</low>` | Lower pitch |
| `<high>text</high>` | Higher pitch |
| `<breathy>text</breathy>` | Breathy voice |

Tags can be combined: `<slow><soft>Goodnight, sleep well.</soft></slow>`

### Example

```
So I walked in and [pause] there it was. [laugh] I honestly could not believe it! <whisper>It was a secret the whole time.</whisper>
```

---

## Error Handling

| Status | Meaning | Action |
|--------|---------|--------|
| `200` | Success | Audio bytes in response body |
| `400` | Bad request | Check: text non-empty, under 15k chars, valid codec/sample_rate |
| `401` | Unauthorized | API key missing or invalid |
| `404` | Not found | Unknown `voice_id` — verify via `GET /v1/tts/voices` |
| `429` | Rate limited | Exponential backoff retry |
| `500` | Server error | Exponential backoff retry |
| `503` | Service unavailable | Retry with backoff |

---

## Limits

| Property | Unary (`POST /v1/tts`) | WebSocket (`wss://api.x.ai/v1/tts`) |
|----------|-------------------------|-------------------------------------|
| Max text length | 15,000 chars | No limit (15k per `text.delta`) |
| Request timeout | 15 minutes | No timeout |
| Concurrent sessions | — | 50 per team |

---

## nSpeech Integration Notes

### PCM path (preferred)

Request PCM at 24kHz, pipe into existing `pipePcmToClient`:
```
POST /v1/tts
{"text": "...", "voice_id": "eve", "language": "en", "output_format": {"codec": "pcm", "sample_rate": 24000}}
→ raw s16le 24kHz mono PCM bytes
→ pipePcmToClient → ffmpeg transcode → MP3/Opus/AAC → client
```

Same integration pattern as MiniMax (hex-decode → PCM → pipe) and ElevenLabs (raw PCM → pipe). No special handling needed.

### API shape differences

- `input` → `text` (standard OpenAI mapping)
- `voice` → `voice_id` (slight rename)
- `speed` → `speed` (same field, different range: 0.7–1.5 vs OpenAI's 0.25–4.0)
- `response_format` → `output_format.codec` (nested object, not flat string)
- No `model` field in request body — model is implicit
- `language` is **required** (or `auto`)

### Voice cloning migration

xAI clones live on their servers (like MiniMax, unlike ElevenLabs). No local `.pt` cache. Clone via `POST /v1/custom-voices`, use returned `voice_id` in TTS requests. Voice listing via `GET /v1/custom-voices`.

### What to skip for now

- **WebSocket streaming** — nSpeech's cloud adapter model is sync HTTP. WS streaming can be added later if real-time TTS with barge-in is needed.
- **Timestamps** — not needed for nSpeech's current use cases. Add as `extra_body.with_timestamps` later if Arena Slides word-level sync is desired.
- **Speech tags** — passthrough in `text`. The adapter doesn't parse or validate them. Users embed tags directly in the input text.
