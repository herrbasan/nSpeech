# Fish Audio — Cloud TTS Provider

**Base URL:** `https://api.fish.audio`
**Endpoint:** `POST /v1/tts` (streaming and batch)
**Auth:** `Authorization: Bearer <FISH_AUDIO_API_KEY>`
**API key source:** [fish.audio > API keys](https://fish.audio/app/api-keys/)
**Docs:** https://docs.fish.audio/features/text-to-speech
**Model docs:** https://docs.fish.audio/developer-guide/models-pricing/choosing-a-model
**Open weights:** https://huggingface.co/fishaudio

> Fish Audio's S2 / S2.1 family, integrated 2026-08-28 as a rival to F5-TTS. **Currently PARKED as an evaluation**, retained as a cloud fallback: with a cloned reference it makes fewer errors than F5 but is noticeably **monotone** — delivery is not drawn from the reference register (the same class as Audio8 and VibeVoice).

---

## Models

Selected by a **`model` HTTP header**, not a body field. All four are real (verified 2026-09-10).

| Provider model | nSpeech slug | Tier | Status |
|----------------|--------------|------|--------|
| `s2.1-pro-free` | `fish_s2_1_pro_free` | Free | ✅ working |
| `s2.1-pro` | `fish_s2_1_pro` | Paid | needs credit |
| `s2-pro` | `fish_s2_pro` | Paid | needs credit |
| `s1` | `fish_s1` | Legacy paid | needs credit |

**nSpeech default:** `s2.1-pro-free`.

> **Provider default is `s2.1-pro`** — Fish uses that whenever the `model` header is omitted or unrecognised. nSpeech's adapter always sends a header and defaults to the free tier instead, so nSpeech requests never silently land on the paid model.

> The three paid models are addressable but return **`402 Insufficient API credit`** — Fish manages API credit separately from platform credit. That surfaces to the caller as `402 payment_required` carrying the provider's own message, rather than a generic 503.

A local s2.cpp GGUF run (q6_k/q8_0, fits the ~11 GB free VRAM on BADKID) was researched and parked pending the quality verdict. Open weights are published by `fishaudio` on HuggingFace.

---

## Voices

**No built-in catalog.** `GET /model?self=true&page_size=100` returns the caller's own voice models — that *is* the whole list. With no `reference_id` the service falls back to its own default voice.

| Exposed field | Source |
|---------------|--------|
| `voice_id` | `_id` |
| `name` | `title` |
| `category` | always `cloned` |
| `description` / `labels` | `description` / `tags` |

### ⚠️ The `default` gotcha

`voice: "default"` (nSpeech's normal default) must **never** be forwarded as `reference_id` — Fish answers `400 Reference not found`. The adapter omits the field entirely when the voice is empty or `"default"`.

## Cloning

`POST /model` multipart:

| Field | Value |
|-------|-------|
| `type` | `tts` |
| `title` | voice name |
| `visibility` | `private` |
| `train_mode` | `fast` — returns a usable model almost immediately (`state: trained`) |
| `voices` | reference audio (wav) |
| `texts` | transcript — sharpens pronunciation |

`POST /v1/voices/preview` clones a **throwaway** voice, renders the preview, then deletes the clone so previews don't clutter the voice store (best-effort cleanup — the audio is already in hand).

`DELETE /model/{id}` removes a voice. **Voice mixing is not supported.**

---

## Request

```json
{
  "text": "Hello.",
  "format": "pcm",
  "sample_rate": 24000,
  "prosody": { "speed": 1.0, "normalize_loudness": true }
}
```

`reference_id` is added only when a real voice is supplied. A JSON body is sufficient because voices are referenced by id — msgpack is only needed for inline binary references, which nSpeech does not use.

### Output formats

| Format | Notes |
|--------|-------|
| `mp3` (Fish default) | `mp3_bitrate`: `64` / `128` / `192` |
| `wav` | uncompressed; set `sample_rate` (e.g. `44100`) |
| `pcm` | raw samples, no container — what nSpeech requests |
| `opus` | efficient for streaming; bitrate automatic |

### `extra_body` extensions

| Field | Range / values | Notes |
|-------|----------------|-------|
| `temperature` | — | Sampling temperature; lower = more deterministic |
| `top_p` | — | Nucleus sampling |
| `repetition_penalty` | > 1.0 curbs repeated sounds | |
| `latency` | `balanced` (default) \| `normal` | Stability vs speed. (nSpeech's adapter comment also mentions `low`; the documented values are these two.) |
| `chunk_length` | 100–300 (default 200) | How much text the engine batches before starting. Smaller = sooner audio; larger = more efficient for long text. |
| `normalize` | bool | Expands numbers/dates for natural reading |
| `volume` | number | Mapped into `prosody` |
| `max_new_tokens` | int | Caps audio length per chunk. **Not mapped by nSpeech's adapter.** |

---

## Error handling

| Fish HTTP | nSpeech | `code` |
|-----------|---------|--------|
| `400` | `400` | `invalid_request_error` (e.g. bad `prosody.speed`) |
| `401` | `401` | `invalid_api_key` |
| `402` | `402` | `payment_required` (insufficient API credit) |
| `404` | `404` | `voice_not_found` |
| `429` | `429` | `rate_limit_exceeded` |
| `5xx` | `5xx` | `upstream_error` |

### `speed` is clamped

Fish rejects `prosody.speed` outside **[0.5, 2.0]** with `400 Invalid prosody.speed 3.5. speed must be in [0.5, 2.0].` nSpeech's own API allows 0.25–4.0, so the adapter clamps to the boundary and logs a warning carrying the requested value — see `server/cloud/params.js`.

---

## Limits & performance

| Property | Value |
|----------|-------|
| nSpeech `maxChars` | **8,000** — conservative. Fish chunks internally (`chunk_length` ≤ 300) with no documented hard text limit; the cap keeps nSpeech's own chunking and progress events working for long-form. |
| Measured rate | **2.5–2.8× real-time**, TTFB ~750–850 ms on the free tier (nSpeech measurement, 2026-08-28). Fish's docs quote ~300 ms time-to-first-audio for `latency: balanced`. |
| Output | PCM s16le mono 24 kHz (requested explicitly) |
| Streaming | Response is chunked, so the stream path is genuinely progressive |

---

## Quality verdict (2026-08-29)

**Parked as an evaluation, kept as a cloud fallback.**

- With a cloned reference: **lower error rate than F5, but noticeably monotone** — the delivery is not drawn from the reference register.
- Untested: `[bracket]` style tags in German; `temperature > 0.7` (impractical for long-form — tagging would have to be per chunk).
- **F5 stays the primary GPU engine.**

---

## nSpeech integration notes

- Adapter: `server/cloud/fish.js` — Node, no Python worker, no VRAM.
- Output is requested as raw PCM at 24 kHz, exactly matching the shared PCM contract; Node's `pipePcmToClient` handles PCM→MP3/Opus/AAC.
- Long-form German A/B against F5 is still outstanding.
