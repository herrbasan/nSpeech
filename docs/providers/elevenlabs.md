# ElevenLabs Speech Provider

**Base URL:** `https://api.elevenlabs.io` (default)  
**Regional servers:** `https://api.us.elevenlabs.io`, `https://api.eu.residency.elevenlabs.io`, `https://api.in.residency.elevenlabs.io`, `https://api.sg.residency.elevenlabs.io`  
**Auth:** `xi-api-key: <API_KEY>` (header)  
**API Key source:** [ElevenLabs Dashboard > API Keys](https://elevenlabs.io/app/settings/api-keys)  
**API docs:** https://elevenlabs.io/docs/api-reference/introduction  
**LLM-friendly docs:** Append `.md` to any docs page URL for markdown version (e.g. `https://elevenlabs.io/docs/api-reference/text-to-speech/convert.md`)  
**Full doc index:** https://elevenlabs.io/docs/llms.txt (single-file: https://elevenlabs.io/docs/llms-full.txt)  
**OpenAPI spec:** https://elevenlabs.io/openapi.json / https://elevenlabs.io/openapi.yaml  
**AsyncAPI spec (WebSocket):** https://elevenlabs.io/asyncapi.json / https://elevenlabs.io/asyncapi.yaml

> ElevenLabs is the dominant cloud TTS provider. ~10,000+ voices (premade + shared library), 29 languages, professional-grade voice cloning, and class-leading quality. Pricing per-char, tiered by model.

---

## Models

| Model | Description | Latency | Quality |
|-------|-------------|---------|---------|
| `eleven_v3` | Latest flagship, 29+ languages | Low | Best |
| `eleven_turbo_v2` | Fast, English-only, agent-optimized | Lowest | Good |
| `eleven_flash_v2_5` | Fastest multilingual (32 languages) | Very low | Good |
| `eleven_multilingual_v2` | Full quality, 29 languages | Moderate | Best |
| `eleven_turbo_v2_5` | High quality multilingual turbo | Low | Very good |
| `eleven_v2_flash` | Legacy fast model | Low | Good |
| `eleven_v2_5_flash` | Latest flash | Very low | Good |

**nSpeech default:** `eleven_v3` — latest flagship, best quality (verified 2026-08-13).

### Character limits per model

Authoritative limits from the [Models overview](https://elevenlabs.io/docs/overview/models.md) page:

| Model | Char limit | Approx. duration | Notes |
|-------|-----------|-----------------|-------|
| `eleven_v3` | **5,000** | ~5 min | Latest flagship. Rejects `previous_text`, `next_text`, `optimize_streaming_latency` (HTTP 400 `unsupported_model`). |
| `eleven_multilingual_v2` | **10,000** | ~10 min | Most stable on long-form. Supports `previous_text`/`next_text`. |
| `eleven_flash_v2_5` | **40,000** | ~40 min | Highest limit. Ultra-low latency (~75ms). Supports `previous_text`/`next_text`. |
| `eleven_flash_v2` | **30,000** | ~30 min | English-only. Supports `previous_text`/`next_text`. |

**Deprecated:** `eleven_turbo_v2_5` → `eleven_flash_v2_5`, `eleven_turbo_v2` → `eleven_flash_v2`. Use Flash models instead.

### Model metadata — `GET /v1/models`

Returns all available models with capabilities and limits. Key fields per model:

| Field | Description |
|-------|-------------|
| `model_id` | Unique identifier (e.g. `eleven_v3`) |
| `can_do_text_to_speech` | Whether the model supports TTS |
| `can_use_style` | Whether `voice_settings.style` is supported |
| `max_characters_request_free_user` | Char limit per request for free tier |
| `max_characters_request_subscribed_user` | Char limit per request for paid tier |
| `maximum_text_length_per_request` | Hard max text length |
| `languages` | Supported languages with `language_id` and `name` |
| `model_rates.character_cost_multiplier` | Cost multiplier for this model |
| `concurrency_group` | Concurrency limiting group |

**Use case for nSpeech:** Query this endpoint to discover `max_characters_request_subscribed_user` per model — this is the authoritative char limit for auto-chunking.

---

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/text-to-speech/{voice_id}` | POST | Sync TTS (returns raw audio bytes) |
| `/v1/text-to-speech/{voice_id}/stream` | POST | Streaming TTS (chunked transfer encoding) |
| `/v1/text-to-speech/{voice_id}/with-timestamps` | POST | Sync TTS with character-level timing (JSON response) |
| `/v1/text-to-speech/{voice_id}/stream/with-timestamps` | POST | Streaming TTS with character-level timing (JSON stream) |
| `/v1/text-to-speech/{voice_id}/stream-input` | WS | Real-time WebSocket streaming |
| `/v1/models` | GET | List models with capabilities and limits |
| `/v2/voices` | GET | List my voices (premade + cloned) |
| `/v1/shared-voices` | GET | Browse voice library |
| `/v1/voices/add` | POST | Create cloned voice (multipart) |
| `/v1/voices/{voice_id}` | GET | Get voice metadata |
| `/v1/voices/{voice_id}` | DELETE | Delete a cloned voice |
| `/v1/voices/{voice_id}/edit` | PATCH | Edit voice (name, description, labels) |
| `/v1/user` | GET | Subscription tier, character usage & limits |

---

## Usage & Subscription — `GET /v1/user`

Returns subscription tier, character usage, and limits:

```json
{
  "subscription": {
    "tier": "free",
    "status": "free",
    "character_count": 17231,
    "character_limit": 100000,
    "next_character_count_reset_unix": 1738356858,
    "voice_slots_used": 1,
    "voice_limit": 120,
    "can_use_instant_voice_cloning": true,
    "current_overage": {"amount": "0", "currency": "usd"},
    "billing_period": "monthly_period"
  }
}
```

Key fields: `character_count` / `character_limit` (usage vs cap), `next_character_count_reset_unix` (quota reset), `tier` (`free`/`creator`/`pro`/`enterprise`), `status`, `current_overage`.

---

## 1. Sync TTS — `POST /v1/text-to-speech/{voice_id}`

Primary integration path. Returns raw audio bytes.

### Request

```
POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000
Content-Type: application/json
xi-api-key: <key>

{
  "text": "Hello world.",
  "model_id": "eleven_v3",
  "language_code": null,
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "use_speaker_boost": true,
    "speed": 1.0
  },
  "seed": null,
  "previous_text": null,
  "next_text": null,
  "previous_request_ids": null,
  "next_request_ids": null,
  "apply_text_normalization": "auto"
}
```

### Query Parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `output_format` | enum | `mp3_44100_128` | See Output Format below |
| `enable_logging` | boolean | `true` | `false` = zero retention mode (enterprise only). Disables history features including request stitching. |
| `optimize_streaming_latency` | int | null | **Deprecated.** 0–4 latency optimization level. Higher = faster but lower quality. |

### Body Fields

| Field | Required | Notes |
|-------|----------|-------|
| `text` | ✅ | Text to speak. Max ~5000 chars (model-dependent; check `/v1/models`). |
| `model_id` | | Default `eleven_multilingual_v2`. nSpeech uses `eleven_v3`. |
| `language_code` | | ISO 639-1. Not supported for `multilingual_v2`. |
| `voice_settings.stability` | | 0–1, default 0.5. Lower = more expressive/variable. |
| `voice_settings.similarity_boost` | | 0–1, default 0.75. Higher = closer to original voice. |
| `voice_settings.style` | | 0–1, default 0. Style exaggeration (v2+ models only). |
| `voice_settings.use_speaker_boost` | | Boolean, default true. Boosts speaker similarity. |
| `voice_settings.speed` | | 0.7–1.2, default 1.0. |
| `seed` | | 0–4294967295. Deterministic sampling (best-effort). |
| `previous_text` | | Text that came before this request. Improves continuity when concatenating generations. |
| `next_text` | | Text that comes after this request. Improves continuity. |
| `previous_request_ids` | | Up to 3 prior request IDs for continuity. **Overrides `previous_text`** if both sent. |
| `next_request_ids` | | Up to 3 future request IDs for continuity. **Overrides `next_text`** if both sent. |
| `pronunciation_dictionary_locators` | | Up to 3 `{pronunciation_dictionary_id, version_id}` objects. Applied in order. |
| `apply_text_normalization` | | `auto` (default), `on`, `off`. Controls number/date expansion etc. |
| `apply_language_text_normalization` | | Boolean, default false. Currently Japanese only. Heavily increases latency. |
| `use_pvc_as_ivc` | | **Deprecated.** Boolean, default false. Workaround for PVC latency. |

### Continuity fields — critical for auto-chunking

`previous_text`, `next_text`, `previous_request_ids`, and `next_request_ids` are ElevenLabs' built-in mechanism for multi-request prosody continuity. When splitting long text into chunks:

- **`previous_text`**: Pass the text of the preceding chunk(s). The engine uses this as context to maintain voice/prosody continuity at the start of the new chunk — eliminating the "cold start" artifact.
- **`next_text`**: Pass the text of the following chunk. Helps the engine plan prosody at the end of the current chunk.
- **`previous_request_ids`**: Stronger than `previous_text` — passes actual generated audio context. The engine can match exact voice characteristics from prior generations. If both `previous_request_ids` and `previous_text` are sent, `previous_text` is ignored.
- **`next_request_ids`**: Same but for forward context. Especially useful when regenerating a middle chunk.

**Priority:** `previous_request_ids` > `previous_text` > nothing. Same for next_*.

**⚠️ v3 limitation (verified 2026-08-14):** `eleven_v3` **rejects** `previous_text`, `next_text`, and `optimize_streaming_latency` with HTTP 400 `unsupported_model`. These fields only work with v2 models (`eleven_multilingual_v2`, `eleven_flash_v2_5`, etc.). The nSpeech adapter skips continuity fields for v3 models automatically.

**nSpeech chunking strategy:** Use `previous_text` for simplicity (no need to track request IDs across chunks). If quality is insufficient, upgrade to `previous_request_ids` by capturing the `request-id` response header from each chunk generation. For v3, chunking works but without continuity (simple concatenation + silence padding).

### Output Format

Pass as query param `?output_format=<format>`. Key formats:

| Format | Description | nSpeech use |
|--------|-------------|-------------|
| `pcm_24000` | s16le 24kHz mono PCM | ✅ Preferred (matches nSpeech pipeline) |
| `pcm_16000` | s16le 16kHz mono PCM | Alternative |
| `pcm_44100` | s16le 44.1kHz mono PCM | Higher quality (Pro tier) |
| `mp3_44100_128` | MP3 44.1kHz 128kbps | Default, good for direct browser playback |
| `mp3_22050_32` | MP3 22.05kHz 32kbps | Smallest files |

Full list: `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_32000`, `pcm_44100`, `pcm_48000`, `mp3_22050_32`, `mp3_24000_48`, `mp3_44100_32/64/96/128/192`, `wav_*`, `ulaw_8000`, `alaw_8000`, `opus_48000_*`.

**Note:** `mp3_44100_192` requires Creator tier+. PCM/WAV at 44.1kHz+ requires Pro tier+.

### Response

Returns raw audio bytes with `Content-Type: audio/<format>`. No JSON wrapper.

**Response headers of interest:**

| Header | Description |
|--------|-------------|
| `character-cost` | Character cost for this generation (for billing tracking) |
| `request-id` | Unique request identifier (use for `previous_request_ids` / `next_request_ids`) |
| `x-trace-id` | Trace ID for debugging |

Errors return JSON:

```json
{"detail": [{"loc": ["body", "text"], "msg": "field required", "type": "value_error.missing"}]}
```

### nSpeech integration

Request `pcm_24000` → raw s16le Buffer → pipe directly into `pipePcmToClient`. Identical code path to MiniMax.

---

## 2. Streaming TTS — `POST /v1/text-to-speech/{voice_id}/stream`

Same body and query params as sync TTS. Returns audio as a chunked transfer stream (not SSE — raw audio chunks).

**Response:** Streaming audio data. Content-Type: `audio/<format>`.

**nSpeech integration:** The adapter uses this endpoint for streaming mode. ElevenLabs streams raw PCM chunks — pipe directly into Readable.

---

## 3. TTS with Timestamps — `POST /v1/text-to-speech/{voice_id}/with-timestamps`

Sync TTS with character-level timing alignment. Same body/query as sync TTS, but returns JSON instead of raw audio.

### Response (200)

```json
{
  "audio_base64": "base64_encoded_audio_string",
  "alignment": {
    "characters": ["H", "e", "l", "l", "o"],
    "character_start_times_seconds": [0.0, 0.05, 0.1, 0.15, 0.2],
    "character_end_times_seconds": [0.05, 0.1, 0.15, 0.2, 0.25]
  },
  "normalized_alignment": {
    "characters": ["H", "e", "l", "l", "o"],
    "character_start_times_seconds": [0.0, 0.05, 0.1, 0.15, 0.2],
    "character_end_times_seconds": [0.05, 0.1, 0.15, 0.2, 0.25]
  }
}
```

| Field | Description |
|-------|-------------|
| `audio_base64` | Base64-encoded audio data (decode to get raw PCM) |
| `alignment` | Per-character timing for the **original** text |
| `normalized_alignment` | Per-character timing for the **normalized** text (after text normalization expands numbers, etc.) |

**nSpeech use case:** This endpoint enables overlap+trim chunking. By requesting timestamps for a chunk that includes overlap text from the previous chunk, you can find the exact audio offset where the new content begins and trim everything before it.

**Caveat:** The alignment is character-level against the original text. Mapping text offsets to audio offsets requires careful character counting — ElevenLabs may normalize whitespace or expand abbreviations differently than a naive count. Use `normalized_alignment` when working with normalized text.

---

## 4. Streaming TTS with Timestamps — `POST /v1/text-to-speech/{voice_id}/stream/with-timestamps`

Same body/query as streaming TTS. Returns a stream of JSON objects, each containing audio + alignment chunks.

**Response:** Streaming response of JSON objects with `audio_base64`, `alignment`, and `normalized_alignment` fields per chunk.

---

## 5. Voice Management

### List my voices — `GET /v2/voices`

```
GET /v2/voices?page_size=100&voice_type=personal
```

Response:

```json
{
  "voices": [
    {
      "voice_id": "JBFqnCBsd6RMkjVDRZzb",
      "name": "George - Warm, Captivating Storyteller",
      "category": "premade",
      "labels": {"accent": "british", "age": "middle_aged", "gender": "male"},
      "description": "Warm resonance that instantly captivates listeners.",
      "preview_url": "https://...mp3",
      "high_quality_base_model_ids": ["eleven_turbo_v2", "eleven_multilingual_v2"],
      "verified_languages": [{"language": "en", "model_id": "eleven_turbo_v2", "accent": "british"}]
    }
  ],
  "has_more": false,
  "total_count": 1,
  "next_page_token": null
}
```

Filters: `voice_type` (`personal`, `community`, `default`, `non-community`), `category` (`premade`, `cloned`, `generated`, `professional`), `search`, `page_size` (max 100).

### Shared voice library — `GET /v1/shared-voices`

Browse the community voice library. More detailed response with `accent`, `gender`, `age`, `descriptive`, `use_case`, `preview_url`, `usage_character_count_1y`, etc.

### Create cloned voice — `POST /v1/voices/add`

```
POST /v1/voices/add
Content-Type: multipart/form-data
xi-api-key: <key>

name: My Custom Voice
files: <binary wav/mp3>
description: Natural voice for narration.
labels: {"accent": "american", "gender": "male", "age": "young"}
```

Response: `{voice_id: "..."}`

### Delete voice — `DELETE /v1/voices/{voice_id}`

Only works for cloned/generated voices (not premade).

---

## 6. Voice Settings → nSpeech extra_body Mapping

ElevenLabs provides per-request voice fine-tuning:

| nSpeech `extra_body` | ElevenLabs field | Notes |
|---|---|---|
| `stability` | `voice_settings.stability` | 0–1, lower = more expressive |
| `expressiveness` | `voice_settings.style` | 0–1, style exaggeration (v2+ only) |
| `guidance_scale` | `voice_settings.similarity_boost` | 0–1, voice adherence |
| `speed` | `voice_settings.speed` | Top-level OpenAI field, maps to 0.7–1.2 |
| `seed` | `seed` | 0–4294967295 |
| `language` | `language_code` | ISO-639-1 |
| `model` | `model_id` | `extra_body.model` overrides top-level model |

---

## 7. nSpeech Adapter — `server/cloud/elevenlabs.js`

### Current implementation

The adapter implements the same streaming PCM contract as `WorkerProcess`:

- `generatePcmStream()` — batch (non-streaming endpoint) or streaming (`/stream` endpoint)
- `listVoices()` — cached for 5 minutes, fetches `GET /v2/voices?voice_type=personal`
- `cloneVoice()` — multipart POST to `/v1/voices/add`
- `previewVoice()` — clone + generate
- `deleteVoice()` — `DELETE /v1/voices/{voice_id}`

### Default model

`eleven_v3` (set in adapter, verified 2026-08-13).

### Key differences from MiniMax

| Aspect | MiniMax | ElevenLabs |
|--------|---------|------------|
| TTS output | Hex-encoded JSON | Raw binary bytes |
| Streaming | SSE chunks | Raw bytes (chunked transfer) |
| PCM format | s16le hex | s16le raw |
| Voice list | `POST /v1/get_voice` | `GET /v2/voices` (paginated) |
| Cloning | 3-step: upload → clone → use | 1-step: multipart POST |
| Delete | `POST /v1/delete_voice` with `voice_type` | `DELETE /v1/voices/{voice_id}` |
| Model selection | Per-request `model` field | Per-request `model_id` field |
| Voice count | 332 system voices | ~10,000+ (premade + library) |
| Continuity | — | `previous_text`, `next_text`, `previous_request_ids`, `next_request_ids` |
| Timestamps | — | `/with-timestamps` and `/stream/with-timestamps` endpoints |

### Audio pipeline

ElevenLabs returns raw PCM at the requested sample rate. nSpeech requests `pcm_24000` (s16le 24kHz mono) — identical to the existing Node ffmpeg pipeline. No hex decoding, no JSON parsing. `Readable.from(Buffer.from(rawPcm))` and feed to `pipePcmToClient`.

### Voice directory

ElevenLabs `GET /v2/voices?voice_type=personal` returns premade + cloned voices. The adapter strips labels (`accent`, `gender`, `age`, `description`) into voice metadata for the dashboard.

---

## 8. Auto-Chunking Design Notes

ElevenLabs has a per-request text limit (~5000 chars, model-dependent). For long-form TTS (RAUM blog posts, 3K–11K chars), nSpeech must split text into chunks and stitch the audio.

### Two continuity approaches

**Approach A — `previous_text` / `next_text` (recommended, simpler):**

Pass the preceding chunk's text as `previous_text` on each subsequent chunk. The engine uses this as prosody context — no audio overlap, no trimming needed. Simple PCM concatenation.

```
Chunk 1: text=para1+para2+para3, previous_text=null
Chunk 2: text=para4+para5+para6, previous_text="para1+para2+para3"
Chunk 3: text=para7+para8,       previous_text="para4+para5+para6"
```

Pros: no timestamps, no audio cutting, engine-agnostic pattern (other providers may add similar fields).  
Cons: text-only context may not fully eliminate the cold-start artifact. Needs testing.

**Approach B — `previous_request_ids` (stronger continuity):**

Capture the `request-id` response header from each chunk and pass up to 3 as `previous_request_ids` on the next chunk. The engine matches actual generated audio characteristics.

```
Chunk 1 → response header request-id: "abc123"
Chunk 2: previous_request_ids=["abc123"]
Chunk 2 → response header request-id: "def456"
Chunk 3: previous_request_ids=["abc123", "def456"]
```

Pros: strongest continuity — engine has actual audio context, not just text.  
Cons: requires `enable_logging=true` (default) — request IDs are unavailable in zero-retention mode. Must track IDs across chunks.

**Approach C — Overlap + timestamp trimming (most complex):**

Prepend overlap paragraphs to each chunk, generate with `/with-timestamps`, use alignment data to find the trim point, cut the overlap audio. Described in `docs/nSpeech-chunking-handover.md`.

Pros: most precise control.  
Cons: requires the non-streaming `/with-timestamps` endpoint (no streaming), complex character-offset-to-audio-offset mapping, fragile against text normalization differences.

### Recommendation

Start with Approach A (`previous_text`). Test whether the cold-start artifact is eliminated. If not, upgrade to Approach B (`previous_request_ids`). Only fall back to Approach C (timestamps) if both are insufficient.

**v3 caveat:** `eleven_v3` does not support `previous_text`/`next_text` (HTTP 400 `unsupported_model`). For v3, chunking uses simple concatenation + silence padding. If continuity is critical for v3, consider using `eleven_multilingual_v2` or `eleven_flash_v2_5` for long-form content (higher char limits + continuity support).

### Char limit discovery

Query `GET /v1/models` to get `max_characters_request_subscribed_user` per model. This is the authoritative limit — use it (minus a safety margin) as the chunk size threshold.

---

## 9. Documentation Reference Links

All links are markdown versions (append `.md` to any docs page URL).

### Text to Speech

| Endpoint | Docs |
|----------|------|
| Create speech (`POST /v1/text-to-speech/{voice_id}`) | https://elevenlabs.io/docs/api-reference/text-to-speech/convert.md |
| Stream speech (`POST /v1/text-to-speech/{voice_id}/stream`) | https://elevenlabs.io/docs/api-reference/text-to-speech/stream.md |
| Create speech with timing (`POST .../with-timestamps`) | https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps.md |
| Stream speech with timing (`POST .../stream/with-timestamps`) | https://elevenlabs.io/docs/api-reference/text-to-speech/stream-with-timestamps.md |
| WebSocket streaming (`/stream-input`) | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input.md |
| Multi-Context WebSocket (`/multi-stream-input`) | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input.md |

### Models

| Endpoint | Docs |
|----------|------|
| List models (`GET /v1/models`) | https://elevenlabs.io/docs/api-reference/models/list.md |

### Voices

| Endpoint | Docs |
|----------|------|
| List voices (`GET /v2/voices`) | https://elevenlabs.io/docs/api-reference/voices/search.md |
| Get voice (`GET /v1/voices/{voice_id}`) | https://elevenlabs.io/docs/api-reference/voices/get.md |
| Delete voice (`DELETE /v1/voices/{voice_id}`) | https://elevenlabs.io/docs/api-reference/voices/delete.md |
| Edit voice (`PATCH /v1/voices/{voice_id}`) | https://elevenlabs.io/docs/api-reference/voices/update.md |
| List shared voices (`GET /v1/shared-voices`) | https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared.md |
| Add shared voice (`POST /v1/shared-voices/add`) | https://elevenlabs.io/docs/api-reference/voices/voice-library/share.md |
| Get default voice settings (`GET /v1/voices/settings/default`) | https://elevenlabs.io/docs/api-reference/voices/settings/get-default.md |
| Get voice settings (`GET /v1/voices/{voice_id}/settings`) | https://elevenlabs.io/docs/api-reference/voices/settings/get.md |
| Edit voice settings (`POST /v1/voices/{voice_id}/settings`) | https://elevenlabs.io/docs/api-reference/voices/settings/update.md |
| Find similar voices (`POST /v1/voices/{voice_id}/similar`) | https://elevenlabs.io/docs/api-reference/voices/find-similar-voices.md |

### IVC (Instant Voice Clone)

| Endpoint | Docs |
|----------|------|
| Create IVC voice (`POST /v1/voices/add`) | https://elevenlabs.io/docs/api-reference/voices/ivc/create.md |

### PVC (Professional Voice Clone)

| Endpoint | Docs |
|----------|------|
| Create PVC voice | https://elevenlabs.io/docs/api-reference/voices/pvc/create.md |
| Update PVC voice | https://elevenlabs.io/docs/api-reference/voices/pvc/update.md |
| Train PVC voice | https://elevenlabs.io/docs/api-reference/voices/pvc/train.md |
| Add samples to PVC voice | https://elevenlabs.io/docs/api-reference/voices/pvc/samples/create.md |

### Bulk references

- **Full page index:** https://elevenlabs.io/docs/llms.txt
- **Single-file full docs:** https://elevenlabs.io/docs/llms-full.txt
- **TTS section index:** https://elevenlabs.io/docs/api-reference/text-to-speech/llms.txt
- **Voices section index:** https://elevenlabs.io/docs/api-reference/voices/llms.txt
- **Models section index:** https://elevenlabs.io/docs/api-reference/models/llms.txt
