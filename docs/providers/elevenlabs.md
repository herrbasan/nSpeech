# ElevenLabs Speech Provider

**Base URL:** `https://api.elevenlabs.io`  
**Auth:** `xi-api-key: <API_KEY>` (header)  
**API Key source:** [ElevenLabs Dashboard > API Keys](https://elevenlabs.io/app/settings/api-keys)

> ElevenLabs is the dominant cloud TTS provider. ~10,000+ voices (premade + shared library), 29 languages, professional-grade voice cloning, and class-leading quality. Pricing per-char, tiered by model.

---

## Models

| Model | Description | Latency | Quality |
|-------|-------------|---------|---------|
| `eleven_turbo_v2` | Fast, English-only, agent-optimized | Lowest | Good |
| `eleven_flash_v2_5` | Fastest multilingual (32 languages) | Very low | Good |
| `eleven_multilingual_v2` | Full quality, 29 languages | Moderate | Best |
| `eleven_turbo_v2_5` | High quality multilingual turbo | Low | Very good |
| `eleven_v2_flash` | Legacy fast model | Low | Good |
| `eleven_v2_5_flash` | Latest flash | Very low | Good |

**nSpeech default:** `eleven_turbo_v2_5` — best quality/speed balance for production use.

---

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/text-to-speech/{voice_id}` | POST | Sync TTS (returns raw audio bytes) |
| `/v1/text-to-speech/{voice_id}/stream` | POST | Streaming TTS (SSE, `text/event-stream`) |
| `/v1/text-to-speech/{voice_id}/stream-input` | WS | Real-time WebSocket streaming |
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
  "model_id": "eleven_turbo_v2_5",
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
  "apply_text_normalization": "auto"
}
```

### Key Fields

| Field | Required | Notes |
|-------|----------|-------|
| `text` | ✅ | Text to speak. Max 5000 chars. |
| `model_id` | | Default `eleven_multilingual_v2`. One of the model IDs above. |
| `voice_settings.stability` | | 0–1, default 0.5. Lower = more expressive/variable. |
| `voice_settings.similarity_boost` | | 0–1, default 0.75. Higher = closer to original voice. |
| `voice_settings.style` | | 0–1, default 0. Style exaggeration (v2+ models only). |
| `voice_settings.use_speaker_boost` | | Boolean, default true. Boosts speaker similarity. |
| `voice_settings.speed` | | 0.7–1.2, default 1.0. |
| `seed` | | 0–4294967295. Deterministic sampling (best-effort). |
| `previous_text` / `next_text` | | Continuity context for multi-request sequences. |
| `previous_request_ids` | | Up to 3 prior request IDs for continuity. |
| `apply_text_normalization` | | `auto`, `on`, `off`. Default `auto`. |

### Output Format

Pass as query param `?output_format=<format>`. Key formats:

| Format | Description | nSpeech use |
|--------|-------------|-------------|
| `pcm_24000` | s16le 24kHz mono PCM | ✅ Preferred (matches nSpeech pipeline) |
| `pcm_16000` | s16le 16kHz mono PCM | Alternative |
| `pcm_44100` | s16le 44.1kHz mono PCM | Higher quality (Pro tier) |
| `mp3_44100_128` | MP3 44.1kHz 128kbps | Default, good for direct browser playback |
| `mp3_22050_32` | MP3 22.05kHz 32kbps | Smallest files |

Full list: `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_32000`, `pcm_44100`, `pcm_48000`, `mp3_22050_32`, `mp3_44100_32/64/96/128/192`, `wav_*`, `ulaw_8000`, `opus_48000_*`.

### Response

Returns raw audio bytes with `Content-Type: audio/<format>`. No JSON wrapper. Errors return JSON:

```json
{"detail": [{"loc": ["body", "text"], "msg": "field required", "type": "value_error.missing"}]}
```

### nSpeech integration

Request `pcm_24000` → raw s16le Buffer → pipe directly into `pipePcmToClient`. Identical code path to MiniMax.

---

## 2. Voice Management

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

## 3. Voice Settings → nSpeech extra_body Mapping

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

## 4. nSpeech Integration Plan

### Adapter: `server/cloud/elevenlabs.js`

```js
// Same pattern as MiniMax adapter
async generatePcmStream({ text, voice_name, speed, extra_body, model }) {
  const eb = extra_body || {};
  const url = `${BASE_URL}/v1/text-to-speech/${voice_name}?output_format=pcm_24000`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: model || 'eleven_turbo_v2_5',
      voice_settings: {
        stability: eb.stability ?? 0.5,
        similarity_boost: eb.guidance_scale ?? 0.75,
        style: eb.expressiveness ?? 0,
        use_speaker_boost: true,
      },
      seed: eb.seed,
    }),
  });

  // Response is raw PCM bytes — wrap in Readable
  return Readable.from(Buffer.from(await resp.arrayBuffer()));
}
```

### Key differences from MiniMax

| Aspect | MiniMax | ElevenLabs |
|--------|---------|------------|
| TTS output | Hex-encoded JSON | Raw binary bytes |
| Streaming | SSE chunks | Raw bytes (or WebSocket) |
| PCM format | s16le hex | s16le raw |
| Voice list | `POST /v1/get_voice` | `GET /v2/voices` (paginated) |
| Cloning | 3-step: upload → clone → use | 1-step: multipart POST |
| Delete | `POST /v1/delete_voice` with `voice_type` | `DELETE /v1/voices/{voice_id}` |
| Model selection | Per-request `model` field | Per-request `model_id` field |
| Voice count | 332 system voices | ~10,000+ (premade + library) |

### Audio pipeline

ElevenLabs returns raw PCM at the requested sample rate. nSpeech requests `pcm_24000` (s16le 24kHz mono) — identical to the existing Node ffmpeg pipeline. No hex decoding, no JSON parsing. `Readable.from(Buffer.from(rawPcm))` and feed to `pipePcmToClient`.

### Voice directory

ElevenLabs `GET /v2/voices?voice_type=personal` returns premade + cloned voices. The adapter strips labels (`accent`, `gender`, `age`, `description`) into voice metadata for the dashboard.

---

## 5. Open Questions / TODOs

- [ ] **API key needed** — register at https://elevenlabs.io and add `ELEVENLABS_API_KEY` to `.env`
- [ ] **Streaming WebSocket** — `/v1/text-to-speech/{voice_id}/stream-input` offers word-to-audio alignment and chunk-level streaming. More complex than HTTP but better for real-time.
- [ ] **Voice clone quality** — ElevenLabs cloning is SOTA; test with nSpeech's `voices_samples/` for quality comparison vs MiniMax
- [ ] **Pricing check** — Free tier has 10K chars/month. Scale costs vary by model tier.
- [ ] **Pagination** — `GET /v2/voices` is paginated (`page_size`, `next_page_token`). Need to handle in adapter.
