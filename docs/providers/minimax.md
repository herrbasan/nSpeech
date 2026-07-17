# MiniMax Speech Provider

**Base URL:** `https://api.minimax.io`  
**Alt (low-latency):** `https://api-uw.minimax.io`  
**Auth:** `Authorization: Bearer <SUBSCRIPTION_KEY>`  
**Key format:** `sk-cp-...` (Token Plan Subscription Key from [Billing > Token Plan](https://platform.minimax.io/user-center/payment/token-plan))

> **Key types:** Token Plan uses `sk-cp-` Subscription Keys. Standard `sk-api-` pay-as-you-go API keys are **not interchangeable** per MiniMax FAQ. Token Plan covers all models on the API platform (speech included) — usage deducts from the unified quota pool.
>
> **Verified 2026-07-02:** HTTP T2A, streaming SSE, PCM output, and voice listing all work with a `sk-cp-` key.

---

## Models

| Model | Description | Price |
|-------|-------------|-------|
| `speech-2.8-hd` | Ultra-realistic, sound tags (interjections) | $100/M chars |
| `speech-2.8-turbo` | Speed + natural flow | $60/M chars |
| `speech-2.6-hd` | Ultra-low latency, intelligence parsing | $100/M chars |
| `speech-2.6-turbo` | Fast, affordable, agent-optimized | $60/M chars |
| `speech-02-hd` | Rhythm stability, replication similarity | $100/M chars |
| `speech-02-turbo` | Multilingual, rhythm stability | $60/M chars |

**Pricing note:** 2.8 and 2.6 series are current. speech-02 and speech-01 are legacy. Voice cloning: $1.50/voice. Voice design: $3/voice.

---

## Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/t2a_v2` | POST | Sync TTS (HTTP, streaming + non-streaming) |
| `ws://.../ws/v1/t2a_v2` | WS | Sync TTS (WebSocket, real-time streaming) |
| `/v1/t2a_async_v2` | POST | Async TTS (long-form, up to 1M chars) |
| `/v1/query/t2a_async_query_v2` | GET | Query async task status |
| `/v1/voice_clone` | POST | Instant voice clone + preview audio |
| `/v1/files/upload` | POST | Upload audio for cloning |
| `/v1/files/retrieve_content` | GET | Download generated audio files |
| `/v1/get_voice` | POST | List voices (system, cloned, generated) |
| `/v1/delete_voice` | POST | Delete a cloned/generated voice |
| `/v1/token_plan/remains` | GET | Token Plan quota remaining |

---

## Usage — `GET /v1/token_plan/remains` (Token Plan only)

Token Plan users (`sk-cp-` keys) can query remaining quota. Note: this endpoint uses the **www** host, not **api**:

```
GET https://www.minimax.io/v1/token_plan/remains
Authorization: Bearer <SUBSCRIPTION_KEY>
```

Response includes remaining quota across the unified pool (speech + LLM + video + music share one bucket). Quota resets on 5-hour rolling + weekly windows.

> **Verified 2026-07-02:** The Token Plan key returned `1004 login fail` against this endpoint — may require a different host or endpoint path. Standard `sk-api-` keys are not supported (only `sk-cp-`).

---

## 1. Sync TTS — HTTP (`POST /v1/t2a_v2`)

Primary integration path for nSpeech. Synchronous, up to 10,000 chars per request. Supports streaming via SSE.

### Request

```json
{
  "model": "speech-2.8-hd",
  "text": "Hello, this is a test.",
  "stream": false,
  "output_format": "hex",
  "voice_setting": {
    "voice_id": "English_expressive_narrator",
    "speed": 1.0,
    "vol": 1.0,
    "pitch": 0,
    "emotion": null
  },
  "audio_setting": {
    "sample_rate": 32000,
    "bitrate": 128000,
    "format": "mp3",
    "channel": 1
  },
  "language_boost": "auto",
  "pronunciation_dict": {
    "tone": ["omg/oh my god"]
  },
  "voice_modify": {
    "pitch": 0,
    "intensity": 0,
    "timbre": 0,
    "sound_effects": null
  }
}
```

### Key Fields

| Field | Required | Notes |
|-------|----------|-------|
| `model` | ✅ | One of the model IDs above |
| `text` | ✅ | ≤ 10,000 chars. `\n` for paragraph breaks. `<#x#>` for pauses (seconds, 0.01–99.99). |
| `stream` | | `false` (default) = single JSON response. `true` = SSE stream. |
| `output_format` | | `hex` (default) = base16 audio in JSON. `url` = download URL (24h TTL). `url` only for non-streaming. |
| `voice_setting.voice_id` | ✅ | System voice ID, cloned voice ID, or empty (with `timbre_weights` for mixing) |
| `voice_setting.speed` | | 0.5–2.0, default 1.0 |
| `voice_setting.vol` | | (0, 10], default 1.0 |
| `voice_setting.pitch` | | -12 to 12, default 0 |
| `voice_setting.emotion` | | `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `calm`, `fluent`, `whisper`. Auto-detected if omitted. |
| `voice_setting.text_normalization` | | Boolean. Improves digit reading, slight latency cost. |
| `voice_setting.latex_read` | | Boolean. LaTeX formula reading (Chinese only). Wrap in `$$`. |
| `audio_setting.sample_rate` | | 8000, 16000, 22050, 24000, 32000, 44100 |
| `audio_setting.bitrate` | | 32000, 64000, 128000, 256000 (mp3 only) |
| `audio_setting.format` | | `mp3`, `pcm`, `flac`, `wav`, `pcmu_raw`, `pcmu_wav`, `opus` |
| `audio_setting.channel` | | 1 (mono) or 2 (stereo) |
| `language_boost` | | Language code or `auto`. Enhances minority language/dialect recognition. |
| `pronunciation_dict.tone` | | Array of `"original/replacement"` rules. Supports IPA, pinyin, jyutping, kana. |
| `voice_modify.sound_effects` | | `spacious_echo`, `auditorium_echo`, `lofi_telephone`, `robotic` (one at a time) |
| `timbre_weights` | | Array of `{voice_id, weight:1-100}`. Up to 4 voices mixed. Leave `voice_id` empty when using. |
| `subtitle_enable` / `subtitle_type` | | Boolean + `sentence`/`word`/`word_streaming`. Returns timestamped subtitles. |
| `stream_options.exclude_aggregated_audio` | | Boolean. If true, final SSE chunk excludes the aggregated full audio. |

### Text Features

**Pause control:** `<#0.5#>`, `<#2.0#>` — between speakable segments, not consecutive.

**Interjections (speech-2.8-hd/turbo only):** `(laughs)`, `(chuckle)`, `(coughs)`, `(clear-throat)`, `(groans)`, `(breath)`, `(pant)`, `(inhale)`, `(exhale)`, `(gasps)`, `(sniffs)`, `(sighs)`, `(snorts)`, `(burps)`, `(lip-smacking)`, `(humming)`, `(hissing)`, `(emm)`, `(sneezes)`.

**Inline pronunciation:** Wrap pinyin/IPA/jyutping/kana in half-width parens — `"live (lɪv)"`, `"和平 (he2)平"`.

### Response (non-streaming, `output_format=hex`)

```json
{
  "data": {
    "audio": "<hex-encoded mp3 bytes>",
    "status": 2
  },
  "extra_info": {
    "audio_length": 11124,
    "audio_sample_rate": 32000,
    "audio_size": 179926,
    "bitrate": 128000,
    "audio_format": "mp3",
    "audio_channel": 1,
    "usage_characters": 163,
    "word_count": 163,
    "invisible_character_ratio": 0
  },
  "trace_id": "01b8bf9bb...",
  "base_resp": {
    "status_code": 0,
    "status_msg": "success"
  }
}
```

- `data.audio` is hex-encoded. Decode: `bytes.fromhex(audio)` → raw mp3/pcm/opus bytes.
- `data.status`: `1` = synthesizing, `2` = complete.
- `extra_info.audio_length`: milliseconds.
- `base_resp.status_code`: `0` = success, `1002` = rate limit, `1004` = auth fail, `1039` = TPM exceeded, `1042` = >10% invalid chars.

### Verified behavior (2026-07-02, speech-2.8-hd)

| Metric | Value |
|--------|-------|
| TTFA (non-streaming, 40 chars) | ~1.2s (total 3.4s audio) |
| Streaming chunk count | 7 chunks for 38 char text (6 intermediate + 1 final) |
| PCM encoding | s16le little-endian |
| PCM @ 24000 Hz, 1.5s audio | 71,332 bytes (matches 24000×2×1.486) |
| MP3 output | Valid MPEG with ID3 header |
| Voice list | 332 system voices returned |
| Char→audio ratio | ~8.5 chars per second of speech (at speed=1)

### Response (streaming, SSE)

```
data: {"data":{"audio":"<hex chunk>","status":1},"trace_id":"...","base_resp":{"status_code":0}}
data: {"data":{"audio":"<hex chunk>","status":1},"trace_id":"...","base_resp":{"status_code":0}}
data: {"data":{"audio":"<full hex audio>","status":2},"extra_info":{...},"trace_id":"...","base_resp":{"status_code":0}}
```

- Chunks arrive as SSE `data:` lines with `status: 1`.
- Final chunk has `status: 2` + `extra_info` (metadata). Audio in the final chunk is the **aggregated full audio** (unless `exclude_aggregated_audio: true`).
- Streaming only supports `output_format=hex`.

---

## 2. Sync TTS — WebSocket (`wss://api.minimax.io/ws/v1/t2a_v2`)

Real-time streaming with lower latency than HTTP SSE. Same model, text, voice, and audio params. Up to 10,000 chars.

### Protocol

```
1. Client → Server: {"event":"task_start","model":"speech-2.8-hd","voice_setting":{...},"audio_setting":{...}}
   Server → Client: {"event":"task_started"}

2. Client → Server: {"event":"task_continue","text":"Hello world."}
   Server → Client: {"data":{"audio":"<hex chunk>"},"is_final":false}  (repeated)
   Server → Client: {"data":{"audio":"<hex chunk>"},"is_final":true}

3. Client → Server: {"event":"task_finish"}  (optional, also closes connection)
```

- Auth via `Authorization: Bearer <KEY>` header on WS connect.
- SSL: `wss://`, requires SSL context (can disable verification for testing).
- Audio chunks are hex-encoded, same as HTTP. Accumulate and decode identically.
- One connection = one voice config. For voice changes, open a new WS connection.

### nSpeech integration notes

WebSocket is the preferred path for cloud providers in nSpeech because:
- Lower latency than HTTP SSE (persistent connection, no per-chunk HTTP overhead)
- Matches nSpeech's streaming architecture (yield chunks, `is_final` signal)
- Node can relay WS audio chunks as PCM → ffmpeg → MP3 to the browser

---

## 3. Async TTS (`POST /v1/t2a_async_v2`)

For long-form (>10K chars, up to 1M chars). File-based or text-based input. Returns audio as downloadable file.

### Workflow

```
1. (Optional) Upload text file → POST /v1/files/upload (purpose=t2a_async_input) → file_id
2. Create task → POST /v1/t2a_async_v2 {model, text (or text_file_id), voice_setting, audio_setting} → task_id
3. Poll status → GET /v1/query/t2a_async_query_v2?task_id=<id> → status, file_id
4. Download → GET /v1/files/retrieve_content?file_id=<id> → binary audio
```

### Create task request

```json
{
  "model": "speech-2.8-hd",
  "text": "Long text... (or use text_file_id)",
  "language_boost": "auto",
  "voice_setting": {"voice_id": "...", "speed": 1, "vol": 10, "pitch": 1},
  "pronunciation_dict": {"tone": ["omg/oh my god"]},
  "audio_setting": {"audio_sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 2},
  "voice_modify": {"pitch": 0, "intensity": 0, "timbre": 0, "sound_effects": "spacious_echo"}
}
```

Note: async uses `voice_setting.vol` with range (0, 10] (default 10), while sync HTTP uses (0, 10] (default 1).

### Query response

```json
{
  "task_id": "...",
  "status": "Success",    // Queueing | Running | Success | Failed
  "file_id": "...",        // present when Success
  "audio_duration": 123.4,
  "audio_size": 123456
}
```

### File download

`GET /v1/files/retrieve_content?file_id=<id>` → binary audio bytes. URL valid for **9 hours** from generation.

---

## 4. Voice Cloning (`POST /v1/voice_clone`)

Instant voice cloning. Clone + preview audio in one call. Cloned voice usable immediately via `voice_id`.

### Workflow

```
1. Upload source audio → POST /v1/files/upload (purpose=voice_clone) → file_id
2. (Optional) Upload prompt audio → POST /v1/files/upload (purpose=prompt_audio) → prompt_file_id
3. Clone → POST /v1/voice_clone {file_id, voice_id, clone_prompt, text, model} → preview audio + confirmation
4. Use → reference the voice_id in T2A calls
```

### Upload requirements

| Purpose | Formats | Duration | Max Size |
|---------|---------|----------|----------|
| `voice_clone` (source) | mp3, m4a, wav | 10s – 5 min | 20 MB |
| `prompt_audio` (example) | mp3, m4a, wav | < 8s | 20 MB |

### Clone request

```json
{
  "file_id": "<source_file_id>",
  "voice_id": "my_custom_voice_01",
  "clone_prompt": {
    "prompt_audio": "<prompt_file_id>",
    "prompt_text": "This voice sounds natural and pleasant."
  },
  "text": "Preview text to synthesize with the cloned voice.",
  "model": "speech-2.8-hd"
}
```

- `voice_id`: user-defined, must be unique. Used in subsequent T2A `voice_setting.voice_id`.
- `clone_prompt.prompt_audio`: optional, improves similarity/stability.
- `clone_prompt.prompt_text`: optional, describes the voice characteristics.
- `text`: preview text synthesized immediately. Response includes the preview audio.

### Voice lifecycle

- Cloned voices auto-delete after **7 days of inactivity**.
- Must be used in at least one successful T2A call before appearing in `GET /v1/get_voice` with `voice_type=voice_cloning`.

---

## 5. Voice Management

### List voices (`POST /v1/get_voice`)

```json
// Request
{"voice_type": "all"}

// Response
{
  "system_voice": [
    {"voice_id": "English_expressive_narrator", "voice_name": "Expressive Narrator", "description": [...], "created_time": "1970-01-01"}
  ],
  "voice_cloning": [
    {"voice_id": "my_voice_01", "description": [], "created_time": "2025-08-20"}
  ],
  "voice_generation": [
    {"voice_id": "ttv-voice-...", "description": [], "created_time": "2025-08-20"}
  ],
  "base_resp": {"status_code": 0, "status_msg": "success"}
}
```

`voice_type`: `system`, `voice_cloning`, `voice_generation`, or `all`.

### System voices overview

332+ voices across 13 languages. Full list at [System Voice ID List](https://platform.minimax.io/docs/faq/system-voice-id). Key counts:

| Language | Count | Examples |
|----------|-------|----------|
| English | 45 | `English_expressive_narrator`, `English_radiant_girl`, `English_Aussie_Bloke`, `English_Deep-VoicedGentleman` |
| Chinese (Mandarin) | 34 | `Chinese (Mandarin)_News_Anchor`, `Chinese (Mandarin)_Warm_Girl`, `Chinese (Mandarin)_Radio_Host` |
| Japanese | 15 | `Japanese_IntellectualSenior`, `Japanese_DecisivePrincess`, `Japanese_CalmLady` |
| Korean | 55 | `Korean_AthleticGirl`, `Korean_CalmGentleman`, `Korean_WiseElf` |
| Spanish | 47 | `Spanish_SereneWoman`, `Spanish_Narrator`, `Spanish_SantaClaus` |
| Portuguese | 74 | `Portuguese_SentimentalLady`, `Portuguese_Narrator`, `Portuguese_Godfather` |
| French | 6 | `French_Male_Speech_New`, `French_MovieLeadFemale` |
| German | 3 | `German_FriendlyMan`, `German_SweetLady`, `German_PlayfulMan` |
| Indonesian | 9 | `Indonesian_SweetGirl`, `Indonesian_CalmWoman` |
| Russian | 8 | `Russian_HandsomeChildhoodFriend`, `Russian_BrightHeroine` |
| Italian | 4 | `Italian_BraveHeroine`, `Italian_Narrator` |
| Cantonese | 6 | `Cantonese_ProfessionalHost (F)`, `Cantonese_CuteGirl` |
| Other (NL,VI,AR,TR,UK,TH,PL,RO,GR,CZ,FI,HI) | ~26 | Various |

### Delete voice (`POST /v1/delete_voice`)

```json
{"voice_id": "my_voice_01"}
```

**⚠️ Soft-delete behavior:** Deleted voices disappear from `/v1/get_voice` but the voice_id remains reserved on MiniMax's backend. Re-using the same voice_id for a new clone returns error `2039: voice clone voice id duplicate`. The duration of this reservation is unknown (likely tied to the 7-day TTL for unused voices). Workaround: use a different voice_id (e.g., append `_v2`, `_new`, or a timestamp).

---

## 6. Rate Limits & Constraints

| API | RPM | Notes |
|-----|-----|-------|
| T2A (all models) | 60 | Per minute |
| Voice Cloning | 60 | Per minute |
| Voice Design | 20 | Per minute |

- **Sync T2A:** max 10,000 chars per request. Streaming recommended for >3,000.
- **Async T2A:** max 1,000,000 chars per request.
- **Invalid chars:** ASCII control chars (except `\t`, `\n`). ≤10% → generates with warning. >10% → error `1042`.
- **Audio formats per path:** non-streaming supports `mp3`, `pcm`, `flac`, `wav`, `pcmu_raw`, `pcmu_wav`, `opus`. Streaming only `mp3` with voice effects (`voice_modify`).
- **Cloned voice TTL:** 7 days unused → deletion.

---

## 7. Error Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1000 | Unknown error |
| 1001 | Timeout |
| 1002 | Rate limit exceeded (RPM) |
| 1004 | Authentication failed |
| 1039 | TPM rate limit exceeded |
| 1042 | Invalid characters > 10% |
| 2013 | Invalid input parameters |

---

## 8. nSpeech Integration Plan

### Adapter: `src/nspeech/cloud/minimax.js` (Node, no Python worker)

Per `AUDIO_API_DEV_PLAN.md` §8, cloud adapters run directly in Node as fetch-based modules.

```js
// Skeleton
export async function generate({ text, voice, model, format, speed, ... }) {
  const body = {
    model: model || 'speech-2.8-turbo',
    text,
    stream: true,           // SSE streaming
    output_format: 'hex',
    voice_setting: { voice_id: voice || 'English_expressive_narrator', speed, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'mp3', channel: 1 }
  };

  const resp = await fetch('https://api.minimax.io/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // Parse SSE, yield { audio: Buffer, isFinal: bool }
  // Node ffmpeg relays PCM→MP3 to browser (same pipePcmToClient as local engines)
}
```

### Key differences from local engines

| Aspect | Local (Python) | MiniMax (Node) |
|--------|---------------|----------------|
| Output | Raw PCM 24kHz s16le | Hex-encoded mp3/pcm (via API) |
| Streaming | PCM tensor chunks | SSE hex chunks |
| Transcoding | Node ffmpeg | May need hex→Buffer→PCM→ffmpeg |
| Voices | `list_voices()` on adapter | `GET /v1/get_voice` API call |
| Cloning | Multipart upload → cache `.pt` | Upload → clone API → voice_id |
| Unload | `adapter.unload()` | No-op (stateless) |
| Health | `is_loaded()` | Always ready (just check API key at startup) |

### Model mapping (OpenAI → MiniMax)

```
model: "minimax_speech_2.8_hd"  → speech-2.8-hd
model: "minimax_speech_2.8_turbo" → speech-2.8-turbo
model: "minimax_speech_2.6_turbo" → speech-2.6-turbo (default)
```

### Audio format mapping

MiniMax supports mp3, pcm, flac, wav, opus. PCM is **s16le** (verified) at the requested sample rate. Since Node's `pipePcmToClient` expects raw PCM s16le from the worker, nSpeech can:
- **Option A (preferred):** Request `format: pcm, sample_rate: 24000` from MiniMax, decode hex → Buffer, pipe to ffmpeg (identical to local engine code path)
- **Option B:** Request `format: mp3` from MiniMax, decode hex → Buffer, relay directly to browser (simpler but diverges from local path)

**Recommendation: Option A** — keeps one unified audio pipeline. MiniMax PCM s16le → hex decode → same ffmpeg transcoding as local engines.

### Voice directory

MiniMax voices are remote — no local `.pt` files. nSpeech's `/v1/voices` endpoint can merge:
- Local engine voices (from Python worker, if also active)
- MiniMax system voices (from `GET /v1/get_voice` with `voice_type=system`)
- MiniMax cloned voices (from `GET /v1/get_voice` with `voice_type=voice_cloning`)

Tag `voice_type: "minimax_system"` / `"minimax_cloned"` in the voice list for dashboard filtering.

### Voice cloning through MiniMax

```
POST /v1/voices/clone (Node)
  → multipart audio received
  → POST /v1/files/upload (purpose=voice_clone) → file_id
  → POST /v1/voice_clone {file_id, voice_id: "user_provided_name"} → done
  → voice_id stored in Node-side registry (or just visible via GET /v1/get_voice)
```

No local `.pt` cache. No GPU. No Python worker spawn.

---

## 9. Open Questions / TODOs

- [x] ~~API key verification~~ — Token Plan `sk-cp-` key works. Standard `sk-api-` does not (by design).
- [x] ~~PCM format details~~ — Confirmed s16le little-endian. Sample rate matches request.
- [ ] **PCM @ 32000 Hz test** — nSpeech standard is 24kHz but MiniMax supports up to 44100. Test whether 32000 Hz PCM works cleanly (only tested at 24000 Hz so far).
- [ ] **WebSocket TTFA benchmark** — WS path promises lower latency than HTTP SSE. Test with a 100-char sentence.
- [ ] **Latency vs Kokoro** — Compare MiniMax cloud TTFA vs local Kokoro for short phrases. Cloud may beat GPU cold-start on dots.
- [ ] **Pricing viability** — $60–100/M chars. At ~5 chars/word, ~$0.30–0.50 per 5,000-word article. Compare to local GPU electricity cost.
- [ ] **WebSocket reconnection** — Does MiniMax WS support resume/reconnect, or full new connection per voice change?
