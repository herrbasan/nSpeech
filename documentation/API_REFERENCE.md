# nSpeech API Reference (V3)

nSpeech V3 is a multi-engine TTS **and** STT service. A Node.js (Fastify) server exposes an OpenAI-compatible HTTP API, manages per-engine Python workers and cloud adapters, and transcodes raw PCM→compressed audio via bundled ffmpeg. This is the canonical reference for the `/v1/*` surface.

**Base URL:** `http://<host>:<port>` (default `http://127.0.0.1:2233`).

## Architecture (one line)

`client → Node (Fastify) → engine (Python worker or cloud adapter) → Node (ffmpeg) → client`

Every TTS engine emits raw PCM (s16le, 24 kHz, mono). Node owns format transcoding. Cloud adapters run directly in Node — no Python process.

STT runs in a dedicated local CPU worker (`venv/stt`): faster-whisper large-v3 int8 for transcription, torchaudio MMS_FA for text-constrained forced alignment. It is registered as engine `stt` (`gpu: false`) — engine switching never touches it — and is excluded from the TTS engine surface.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/audio/speech` | OpenAI-compatible TTS |
| POST | `/v1/speech/dialogue` | Multi-speaker MD-Blocks post → one audio file (per-turn synthesis) |
| GET | `/v1/speech/dialogue/:id` | The manifest of a dialogue render (turns, chars, durations, cache) |
| POST | `/v1/audio/speech/clone` | One-shot TTS from uploaded reference (no persistence) |
| GET | `/v1/voices` | List voices on current (or `?engine=`) engine |
| POST | `/v1/voices/clone` | Persist a cloned voice (multipart) |
| POST | `/v1/voices/preview` | Temporary clone + preview audio (multipart) |
| POST | `/v1/voices/mix` | Blend two voices (JSON) |
| POST | `/v1/voices/preset` | Create/update a voice preset (JSON) |
| DELETE | `/v1/voices/:voice_id` | Delete a voice or preset |
| POST | `/v1/admin/engine` | Select the engine the dashboard works with (SSE progress) |
| POST | `/v1/admin/default-engine` | Set the **client default** — what `model: "nspeech"` resolves to |
| GET | `/v1/admin/default-engine` | `{"engine":"<client default>","dashboard":"<browsed>"}` |
| GET | `/v1/admin/engines` | List engines with venv/loaded/type state |
| GET | `/v1/admin/status` | Worker manager state |
| GET | `/v1/admin/events` | Live event stream (SSE) — engine start/stop/error, history replay |
| GET | `/v1/admin/cache` | Voice-cache state (per-engine counts/age) plus `renders` — persisted stitch renders (`entries`, `bytes`, `maxBytes`, `ttlHours`, `dir`) — and `dialogue_turns` (the same shape, for dialogue turn audio) |
| POST | `/v1/admin/cache/refresh` | Rebuild the voice cache now (disk re-scan, cloud re-fetch, resident re-warm) |
| POST | `/v1/audio/transcriptions` | Speech-to-text (local faster-whisper, CPU) |
| POST | `/v1/audio/align` | Forced alignment, text-constrained (local MMS CTC, CPU) |
| POST | `/v1/text/clean` | Speech-ready text cleaning (regex / LLM) |
| GET | `/v1/defaults` | All saved per-engine generation defaults |
| GET | `/v1/defaults/:engine` | One engine's defaults (404 if none) |
| PUT | `/v1/defaults/:engine` | Save `{voice?, speed?, extra_body?}` as engine defaults |
| DELETE | `/v1/defaults/:engine` | Clear engine defaults |
| GET | `/health` | `{"status":"ok","version":"3.0.0","engine":"<client default>","dashboard":"<browsed>"}` |
| GET | `/engine` | `{"engine":"<client default>","dashboard":"<browsed>"}` |

### Server-side defaults

`PUT /v1/defaults/:engine` persists a dial-in (`{voice, speed, extra_body}`) saved from the dashboard's **Save as Default** button. The speech relay merges saved defaults into any request: fields the request leaves unset are filled from the store — explicit request values always win. Defaults apply before preset resolution. `DELETE` (or the dashboard **Reset** button) clears them.

**The dashboard is the admin surface; API clients are the consumers.** The point of a dial-in is that a client can call the API *without* specifying an option and get the admin's value. Two things are therefore essential:

- **Do not send defaulted values.** A client that sends `speed: 1.0` “because that's the default” has made it explicit, and the saved value will be ignored. Omit the field to inherit.
- `voice: "default"` counts as **unset** — that sentinel means "engine default", so a saved voice still applies.

Defaults are stored and looked up **by engine name**, not by the raw `model` string: `"nspeech"`, a cloud slug (`"minimax_speech_2_8_hd"`), a legacy alias and the bare engine name all resolve to the same entry.

```bash
curl -X PUT http://127.0.0.1:2233/v1/defaults/f5tts \
  -H "Content-Type: application/json" \
  -d '{"voice":"Melon_DE","speed":1.0,"extra_body":{"cfg_strength":1.5,"nfe_step":32}}'
```

### Voice cache

`GET /v1/voices` is served from a server-side snapshot, never from the engine directly. The snapshot is built at service start and persisted to `.cache/voice-cache.json`, so a voice listing can't be delayed by a worker spawn or a cloud round-trip.

- **Local engines** — cloned/blended voices are read straight from the engine's voice directory (`venv/<engine>/voices/`) by the same rules the worker applies (Chatterbox needs a `.pt` beside the wav; F5-TTS needs a `.f5tts.txt` transcript sidecar; `__preview__` entries are excluded). No worker, no VRAM. The engine's native catalog (Kokoro's 54 built-ins) is cached from the last authoritative worker answer and persisted across restarts.
- **Cloud engines** — the adapter's catalog is fetched and cached (15-min TTL; the adapter's own 5-min cache sits underneath).
- **Resident CPU engines** — `gpu:false` engines (Kokoro) are warmed at startup by spawning their worker, so their native catalog is captured without any dashboard visit. GPU engines are **never** spawned just to answer a voice listing.

Mutations — clone, delete, mix, preset write — re-derive the affected engine synchronously before responding, so the next read is instant and reflects the write. A successful engine switch also refreshes the now-loaded engine's voices in the background.

**A read never calls an engine.** A stale snapshot is returned as-is and revalidated in the background (stale-while-revalidate), so a client waits only for audio generation — never for a worker relay or a provider round-trip. The one exception is a cache with no entry at all, which can occur only on the very first request after a fresh install before warm-up has landed; even then a local engine resolves without a worker via the disk scan.

Engines and models are deliberately **not** cached: both are built from the local registry and the cloud registry with no network, no worker, and no I/O beyond a `venv` existence check, so there is nothing to gain. Their live fields (`default`, `is_loaded`, `is_current`) are computed per request.

### Bilingual F5-TTS (`model: "f5tts"`)

The `f5tts` engine routes per request between two resident checkpoints: English → `F5TTS_v1_Base` (base), German → `F5-TTS-German` fine-tune (vocos 420k). Routing: `extra_body.language: "de"|"en"` forces it; otherwise a zero-dependency heuristic detects from the text (umlauts/ß decisive, function words break ties, EN wins ties). `cfg_strength` defaults per language: DE 1.5 (2.5 sounds metallic — over-guidance), EN 2.5. Voices (wav + `.f5tts.txt` sidecar) are shared across both.

Note: `f5tts-german` (explicit German pin) is **dashboard-only** (`api_hidden`) — it does not appear in `/v1/models` and is rejected as an API `model` value unless it is the currently-switched engine. API callers use `f5tts` for both languages.

### Fish Audio (models: `fish`, `fish_s2_1_pro_free`, `fish_s2_1_pro`, `fish_s2_pro`, `fish_s1`)

Cloud TTS via `api.fish.audio`. Default model `s2.1-pro-free`. Voice = Fish voice model id (`reference_id`); omit `voice` for Fish's built-in default (do NOT send `"default"` — the API rejects unknown reference ids). `extra_body`: `temperature` (0-1), `top_p`, `repetition_penalty`, `latency` (`normal|balanced|low`), `chunk_length` (100-300), `normalize`, `volume` (dB). Inline `[bracket]` style tags are interpreted by the S2 family.

---

## 1. TTS — `POST /v1/audio/speech`

OpenAI-compatible text-to-speech. Streams audio progressively or buffers fully (batch mode). Cloud and local engines share the same request shape.

### Request (JSON)

```json
{
  "model": "elevenlabs",
  "input": "Hello world.",
  "voice": "JBFqnCBsd6RMkjVDRZzb",
  "response_format": "mp3",
  "speed": 1.0,
  "instructions": "Speak warmly.",
  "extra_body": {
    "pitch": 0,
    "emotion": "calm",
    "expressiveness": 0.5,
    "stability": 0.5,
    "inference_steps": 4,
    "guidance_scale": 1.2,
    "seed": 42,
    "language": "en",
    "model": "eleven_turbo_v2_5",
    "blend": [{"voice_id": "af_heart", "weight": 30}, {"voice_id": "af_bella", "weight": 70}],
    "sample_rate": 24000,
    "channel": 1,
    "bitrate": 128000,
    "sound_effects": "spacious_echo"
  }
}
```

### Standard Fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `model` | string | `"nspeech"` | Engine selector. Accepts any registered engine: `"nspeech"` (the **client default** engine — see below), a local engine name (`"kokoro"` — always resident), a cloud prefix (`"minimax"`), a cloud model slug (`"minimax_speech_2_8_hd"`, `"eleven_v3"`), or a legacy alias (`"elevenlabs_turbo_v2_5"`). `GET /v1/models` is the authoritative list of what is usable **without an engine switch**, with display labels and defaults. |
| `input` | string | **required** | Text to synthesize. |
| `voice` | string | `"default"` | Voice ID. Engine-scoped: `af_heart` exists in Kokoro, not in Chatterbox. |
| `response_format` | string | `"mp3"` | `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`, `pcm_f32`. |
| `speed` | float | engine default | OpenAI range `0.25`–`4.0`. **Leave it out** to inherit the saved per-engine default (see “Server-side defaults”) or, failing that, the engine's own tuned default (F5-TTS `0.9`, others `1.0`). Cloud providers enforce narrower ranges and are clamped at the boundary with a warning logged carrying the requested value: xAI `0.7`–`1.5`, ElevenLabs `0.7`–`1.2`, MiniMax `0.5`–`2.0`, Fish `0.5`–`2.0`. Local engines are unclamped. |
| `instructions` | string | — | Natural-language style direction. Passed through where supported. |

### `extra_body` Extensions

All fields optional. Engines ignore unsupported fields silently — "if you support it, use it; if not, pass."

#### Voice Character

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `pitch` | number | -12..12 | Semitone pitch shift (`voice_setting.pitch`). |
| `vol` | number | (0, 10] | Output volume (`voice_setting.vol`). |
| `emotion` | string | enum | `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `calm`, `whisper`, `fluent`. |
| `voice_modify` | object | — | `{pitch, intensity, timbre, sound_effects}` — deepen/brighten, stronger/softer, fuller/crisper (−100..100 each) plus one sound effect. MiniMax only; forces a buffered WAV render internally (see the provider matrix). |
| `text_normalization_mode` | string | `basic` \| `quality` | MiniMax's own digit/date reading. `quality` is a hybrid LLM + rule pass (slower). |
| `expressiveness` | number | 0..1 | Delivery intensity. 0 = flat, 1 = dramatic. |
| `stability` | number | 0..1 | Voice consistency. 0 = variable, 1 = steady. (ElevenLabs native.) |

#### Quality / Generation

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `batch` | boolean | — | `true` = render full audio before first byte. `false` = stream progressively. |
| `inference_steps` | int | 1..32 | Diffusion/flow NFE. Higher = better quality, slower. |
| `guidance_scale` | number | 0..3 | Voice adherence. Higher = stick closer to cloned voice. |
| `seed` | int | any | Determinstic sampling (best-effort). |

#### Model & Voice

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Sub-model override (provider-native id). e.g. `speech-2.8-turbo` (MiniMax), `eleven_v3` (ElevenLabs). Overrides the sub-model chosen by the top-level `model` slug. |
| `blend` | array | Up to 4 `{voice_id, weight}` pairs. Weight: 1–100. |

#### Audio Output

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `sample_rate` | int | 8000–44100 | Hz. Cloud providers support range; local engines fixed at 24000. |
| `channel` | int | 1, 2 | Mono or stereo. |
| `bitrate` | int | 32000–256000 | Encoded bitrate (mp3 only). |

#### Effects & Text

| Field | Type | Description |
|-------|------|-------------|
| `sound_effects` | string | `spacious_echo`, `auditorium_echo`, `lofi_telephone`, `robotic`. |
| `pronunciation` | object | `{tone: ["original/replacement"]}`. IPA, pinyin, jyutping, kana. |
| `ssml` | boolean | Interpret input as SSML. |
| `language` | string | ISO-639-1 code (`"de"`, `"en"`, ...), BCP-47 for xAI (`"pt-BR"`), or `"auto"`. Omitted = engine default (usually auto-detect). Unsupported values fail with 400 — never silently ignored. See the engine map below. |

#### Text Cleaning

| Field | Type | Description |
|-------|------|-------------|
| `clean` | boolean \| string | `true` = server-side regex clean (fast, deterministic). `'llm'` = regex + LLM **date pass** via local gateway — every date is rewritten as fully spoken words with correct grammar ("12. September" → "am zwölften September" / "September twelfth"). Replaced the prosody-mark pass 2026-09-24 (that pass was parked: worse than regex in ear tests). Legacy alias: `markdown` (same values). |

**Architecture (2026-08-18):** cleaning is **server-authoritative**. Clients that don't need the cleaned text pass `extra_body.clean: true` (SDK: `clean:true` on `speech()`/`speak()`). Clients that need the exact spoken text (e.g. text/audio alignment) call [`POST /v1/text/clean`](#post-v1textclean) first, then send the returned text with `clean` unset. The regex cleaner is also exported by the SDK (`cleanMarkdown`) for offline/preview use — same code the server runs. Rules: emphasis strips silently, label colons (1–2 words, line-initial) merge into a pause, clause colons split into sentence + paragraph break, headers get terminal periods, strikethrough drops, acronyms spell out (`GLM5` → "G L M five"), file extensions speak ("notes.md" → "notes dot m d"). Spaced dashes (em `—`, en `–`, hyphen `-`) become ` ... ` — the most reliable TTS pause. Hashless headings followed directly by a longer line get terminal periods (without one, the engine speaks the heading as part of the next paragraph).

#### Long-Form / Auto-Chunking

When `input` exceeds the engine's per-request char limit, nSpeech transparently splits the text on natural boundaries (paragraph → sentence → clause), generates each chunk sequentially, and stitches the PCM into one continuous response. Clients don't need to know about engine limits.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `'stream'` | `'stream'` = simple chunks, silence-padded joins, progressive delivery. `'stitch'` = seamless joins via spoken overlap + forced alignment + trim (buffered: first byte after full render). `'off'` = no chunking (fails over the engine's char limit). |
| `batch` | boolean | — | Deprecated alias: `true` ≡ `mode:'stitch'`. |
| `auto_chunk` | boolean | — | Deprecated alias: `false` ≡ `mode:'off'`. |
| `chunk_silence_ms` | int | `1000` | Silence inserted between chunks, in milliseconds. `0` = none. |
| `chunk_fade_ms` | int | `15` | Fade-in at the trim boundary to smooth the cut. |
| `chunk_tail_fade_ms` | int | `75` | Fade-out at every chunk tail. Engines may cut the final phoneme with zero decay; without this fade the cliff into the inter-chunk silence is audible as a pop. |
| `chunk_overlap` | int | `1` | Number of trailing paragraphs prepended as overlap in batch mode. |
| `cache` | boolean | `true` | Stitch only. Persist the completed render and serve an identical repeat from disk instead of re-spending quota. `false` bypasses both lookup and store for that request. |

Engine char limits (model-aware): eleven_v4_turbo 9600, eleven_v3 4800, eleven_v4 9600, eleven_multilingual_v2 9600, eleven_flash_v2_5 38400, MiniMax ~9800, Gemini ~4800, xAI ~14800, local engines unlimited. The chunk gate uses the same model-aware limit the planner splits against, so a text over the selected model's limit is always chunked rather than sent as one over-limit request. ElevenLabs v4 models have no speed/style control (values are ignored with a warning); the ElevenLabs default is `eleven_v4_turbo`.

**Stream vs stitch:** `stream` (default) uses simple chunks with silence padding — first byte early, no overlap. `stitch` renders everything before first byte but produces seamless joints: the overlap paragraph is generated as part of each next chunk (warming the engine's prosody), located in the audio via **forced alignment constrained to the known text** (word count is mathematically guaranteed), trimmed at the exact word boundary snapped to the nearest zero crossing (click-free cut), and faded in. Alignment runs on nSpeech's own CPU worker — no external service, unaffected by engine switching anywhere.

**Progress events:** stitch runs emit `tts` events on the admin SSE bus (`/v1/admin/events`) with a single overall progress model: `percent` 0–100 (each chunk owns an equal share; during generation, streamed bytes advance the share, self-calibrating bytes/char after the first chunk) plus a stage label — `plan`, `generating N/M`, `aligning N/M`, `trimmed N/M`, `done`, `failed`.

#### Stitch render cache

A stitch render is buffered by definition, so the finished PCM exists before the first byte is sent. nSpeech persists it to `.cache/renders/` (24 kHz mono s16le `.pcm` plus a `.json` sidecar) **before** responding, which means a client that dies mid-response — timeout, crash, disconnect — no longer costs the quota spent on that render: re-issuing the same request is free.

- **Key:** engine, model, voice, speed, instructions, tuning `extra_body` and the **cleaned** text. Anything that changes the audio changes the entry; transport flags (`mode`, `clean`, `markdown`, `cache`, deprecated aliases) do not.
- **Serve:** an identical request inside the TTL returns the stored bytes instead of rendering. The response carries `X-Render-Cache: hit | miss | off`.
- **Retention:** TTL plus a byte cap, evicted least-recently-used first. Defaults: 7 days, 2 GiB, `.cache/renders`. Configure via `render_cache` in `config.json` (`dir`, `ttl_days`, `max_bytes`) or `NSPEECH_RENDER_CACHE_DIR` / `NSPEECH_RENDER_CACHE_TTL_DAYS` / `NSPEECH_RENDER_CACHE_MAX_BYTES`.
- **Opt out:** `extra_body.cache: false`. A request opted out neither reads nor writes the cache.
- **Only stitch is cached** — `stream` mode never holds the finished render. `GET /v1/admin/cache` reports `renders` (`entries`, `bytes`, `maxBytes`, `ttlHours`, `dir`).
- Disk failures never fail a request: the render is still served, the miss is logged.

### Response

Raw audio bytes with `Content-Type` per format. Every streaming response carries `X-Stream-Mode: native` (real incremental) or `X-Stream-Mode: chunked` (complete file sliced — batch mode or non-streaming cloud providers). A stitch response also carries `X-Render-Cache: hit` (served from `.cache/renders/`), `miss` (rendered and persisted) or `off` (`extra_body.cache: false`).

## 1.1 Dialogue mode — `POST /v1/speech/dialogue`

Renders a multi-speaker MD-Blocks post as **one audio file, one voice per speaker**. Each spoken turn is synthesized separately (reply prosody depends on the turn it answers), trimmed of edge silence, and concatenated with an explicit gap — there is no per-voice batch pass and no re-split step.

**Division of labour.** The document carries **identity only**. Which engine, model and voice render that identity is generation-time configuration and lives outside the document, so a retrained clone or a cheap test render never edits the article.

### Document format (MD-Blocks v1.8)

```md
<!-- mb:block preset=narration:david-a-renelt name="David" -->
> I will carry this for weeks. …
<!-- mb:/block -->

<!-- pause: 1.5 -->

<!-- mb:block preset=narration:kimi-k3 name="Kimi K3" -->
*The story, once you had found it again, is real …*
<!-- mb:/block -->
```

- `preset=narration:<speaker-id>` — the modifier is a speaker identifier. A bare `narration` (no speaker) is an error here: plain single-voice text belongs on `/v1/audio/speech`.
- `name="…"` — optional display name, legal only on narration blocks. One id with two different names is an error (both lines are cited).
- A **turn is one block body**, verbatim. The author controls granularity; the pipeline never merges or splits blocks. Content outside narration blocks is not spoken, and the body's Markdown (`>`, `*`, links) is stripped by the normal cleaning pass.
- `<!-- pause: 1.5 -->` — an ordinary HTML comment to renderers, an exact inter-turn silence to nSpeech. It **replaces** the default gap for that junction rather than adding to it; before the first turn it is leading silence, after the last it is trailing.
- `audio=URL` on a narration block is an **error** here: a recording exists for that turn, and re-rendering it silently would re-bill text the author already paid for.
- N speakers, not two. Source order is delivery order.

### Cast registry

`dialogue-cast.json` at the project root binds speaker id → voice:

```json
{
  "david-a-renelt": { "model": "eleven_v4", "voice_id": "<clone-id>", "settings": {} },
  "kimi-k3":        { "model": "eleven_v4", "voice_id": "<voice-id>", "settings": {} }
}
```

- `model` — addressable nSpeech model slug; or `engine` alone (e.g. `"minimax"`) to use that provider's default model.
- `settings` — passed through as `extra_body`; `speed` is lifted to the top level. A `seed` in settings pins a render (nSpeech does not derive one automatically).
- Resolution: request `cast` override → registry → **400 naming the unbound speaker**. There is no fallback voice and no default engine.
- A cast entry that recasts a speaker onto a different engine/model does **not** inherit the registry's `settings` — those were dialled in for the old engine.
- Server-side defaults (`/v1/defaults/:engine`) still fill anything a binding leaves unset, exactly as on `/v1/audio/speech`.

### Request

```json
{
  "source": { "markdown": "<full post>", "file": "the-drill.md" },
  "cast": { "kimi-k3": { "engine": "minimax", "voice_id": "<minimax-voice>" } },
  "gap_ms": 400,
  "estimate_only": false,
  "response_format": "mp3"
}
```

| Field | Meaning |
|---|---|
| `source.markdown` | Required. The full MD-Blocks document. |
| `source.file` | Optional. Name used in parse error messages. |
| `cast` | Optional per-speaker binding overrides, shallow, may be partial (e.g. only `voice_id`). |
| `gap_ms` | Inter-turn gap, default `400`. `pause` beats override it locally. |
| `estimate_only` | `true` → no engine call, no worker spawn, no charge. Returns the turn manifest. |
| `response_format` | `mp3` (default), `wav`, `pcm`, `opus`, `aac`. |

`estimate_only` is free and is the intended first step before any paid render:

```bash
curl -X POST http://127.0.0.1:2233/v1/speech/dialogue \
  -H "Content-Type: application/json" \
  --data @body.json     # {"source":{"markdown":"..."},"estimate_only":true}
```

It reports `turns`, `speakers[]` (engine, model, voice, turns, chars, binding source), `engines[]` (chars per engine and per model) and `pauses`. Character counts are the billable unit — nSpeech models no provider pricing, so no cost figure is invented.

### Response

Audio bytes. Headers:

| Header | Value |
|---|---|
| `X-Dialogue-Id` | 64-char hex job id — also the manifest filename, and present on failure |
| `X-Dialogue-Turns` | Number of turns rendered |
| `X-Dialogue-Cache` | `<hits>/<turns> hit` |

The manifest is written to `.cache/dialogue/<id>.manifest.json` and served at `GET /v1/speech/dialogue/:id`: per turn `index`, `speaker`, `name`, `line`, `engine`, `model`, `voice`, `chars`, `duration_ms`, `cache`, plus `totals` (`turns`, `chars`, `cache_hits`, `audio_ms`, `bytes`). A failed job writes a `status: "failed"` manifest listing the turns that completed.

### Turn cache

Each turn is its own cache entry, keyed on everything that determines its audio: engine, model, voice, speed, instructions, tuning `extra_body` (including the context text), and the **cleaned** turn text. Consequences, by design:

- Re-running an unchanged post costs nothing and resumes after a failure.
- **A context-capable engine also invalidates the neighbours**: editing a turn changes the `previous_text`/`next_text` of the turns beside it, so an edited middle turn re-renders three turns, not one. This is the price of conversation-shaped prosody, and it is why the edited-turn cost is bounded by the neighbours rather than the document.
- Recasting the whole cast (e.g. a MiniMax test pass) re-renders everything, because the binding is in the key.
- Retention: TTL plus a byte cap, evicted least-recently-used. Defaults: 7 days, 2 GiB, `.cache/dialogue`. Configure via `dialogue.cache` in `config.json` (`dir`, `ttl_days`, `max_bytes`) or `NSPEECH_DIALOGUE_CACHE_DIR` / `NSPEECH_DIALOGUE_CACHE_TTL_DAYS` / `NSPEECH_DIALOGUE_CACHE_MAX_BYTES`. The default gap is `dialogue.gap_ms` / `NSPEECH_DIALOGUE_GAP_MS`.

### Per-engine capabilities

| Capability | Engines | Effect |
|---|---|---|
| Reply context (`previous_text` ≤500 chars, `next_text` ≤250) | ElevenLabs (its v3 family drops the fields itself) | Turns are rendered with the neighbouring text, so intonation answers the actual reply. |
| No context | MiniMax, Gemini, xAI, Fish, local engines | Turns render standalone; gap and beats still apply. A warning is logged once per job. |

A turn longer than the model's limit is chunked through the normal `chunking.js` path (stitch mode), inheriting voice, settings and context.

### Dialogue errors

| Code | Status | Cause |
|---|---|---|
| `missing_source` | 400 | `source.markdown` absent or empty |
| `invalid_gap_ms` / `invalid_cast` | 400 | Malformed request field |
| `md_blocks_syntax` | 400 | Spec violation with a line number (unknown kind/attribute, duplicate key, malformed value, nested/unclosed block, marker inside a block, `mb:/main`, stray `col`, …) |
| `dialogue_no_turns` | 400 | No narration blocks — not a dialogue |
| `dialogue_no_speaker` / `dialogue_preset_invalid` | 400 | Bare narration, or a third `preset` segment |
| `dialogue_audio_recorded` | 400 | `audio=` on a narration block |
| `dialogue_beat_in_turn` | 400 | `pause` beat inside a narration block |
| `dialogue_speaker_conflict` | 400 | One speaker id, two display names |
| `dialogue_speaker_unbound` | 400 | No cast binding for a speaker id (the id is named) |
| `dialogue_binding_invalid` | 400 | Model and engine disagree in one binding |
| `empty_audio` | 502 | An engine produced no audio, or silence, for a turn |

Parse errors are raised **before** any engine work: a malformed document or an unbound speaker never costs a provider call.

## Engine Capabilities
The `model` field selects a provider. Each provider has different strengths, price points, and supported `extra_body` fields. Each cloud provider also exposes multiple **sub-models** — list them via `GET /v1/models` (or `listEngineModels` in the SDK) and select one by passing its slug as `model` (e.g. `"minimax_speech_2_8_hd"`).

### Choosing an engine

| Engine (`model`) | Type | Best for | TTFA | Voice cloning | Max text |
|---|---|---|---|---|---|
| `"nspeech"` | Local GPU | Privacy, offline, unlimited use | <1s | ✅ (engine-dependent) | Unlimited |
| `"minimax"` | Cloud | Best quality, sound effects, 332+ voices | ~1s | ✅ ($1.50/voice) | 10K chars |
| `"elevenlabs"` | Cloud | Voice consistency, 32 languages | ~1s | ✅ (instant) | 5K chars |
| `"gemini"` | Cloud | 80+ languages, auto-detect | ~1s | — | 5K chars |
| `"xai"` | Cloud | Grok integration | ~1s | ✅ | 5K chars |

The local engine behind `"nspeech"` is the **client default**, set independently of what the dashboard is browsing — in the dashboard's Home page engine grid (**Set default**) or via `POST /v1/admin/default-engine`. The dashboard's engine switcher changes the engine the dashboard works with — and, for a local GPU engine, which one is resident — but **not** the client default: browsing or testing a cloud engine leaves `"nspeech"` pointing where it was. Selecting a cloud engine unloads nothing. Local engines are also addressable by name: `"kokoro"` is always available (CPU, `gpu:false`, survives engine switches). Naming a GPU engine other than the client default also works, but forces an engine switch (unload + reload). `GET /v1/models` advertises only the models usable **without** a switch — cloud slugs, resident CPU engines, the client default, and `"nspeech"` itself.

### `extra_body` support by provider

| Field | nspeech (local) | MiniMax | ElevenLabs | Gemini | xAI |
|-------|-----------------|---------|------------|--------|-----|
| `pitch` | — | ✅ `voice_setting.pitch`, −12..12 (provider accepts out-of-range silently; nSpeech clamps) | — | — | — |
| `vol` | — | ✅ `voice_setting.vol`, (0, 10] | — | — | — |
| `emotion` | engine-dependent | ✅ `voice_setting.emotion` (9 values incl. `whisper`) | — | — | — |
| `voice_modify` | — | ✅ `{pitch, intensity, timbre, sound_effects}` — see the PCM note below | — | — | — |
| `text_normalization_mode` | — | ✅ `basic` \| `quality` | — | — | — |
| `expressiveness` | engine-dependent | emotion map | `style` | — | — |
| `stability` | — | — | ✅ native | — | — |
| `batch` | engine-dependent | ✅ | ✅ | ✅ | ✅ |
| `nfe_step` | ✅ f5tts (ODE steps; 16 fast, 64 audiobook) | — | — | — | — |
| `cfg_strength` | ✅ f5tts (guidance; DE 1.5 / EN 2.5) | — | — | — | — |
| `sway_sampling_coef` | ✅ f5tts (variation) | — | — | — | — |
| `seed` | ✅ f5tts | — (no seed support) | ✅ | — | — |
| `blend` | kokoro only | ✅ `timbre_weights` (legacy field, accepted by 2.8; effect unmeasured — no UI) | — | — | — |
| `language` | `f5tts`: `de`/`en` checkpoint routing (`auto`/unset = heuristic detect) · `chatterbox-mtl`: `language_id` (23 codes; turbo/eng ignore it) | ✅ `language_boost` (ISO mapped to MiniMax's official names, `auto` forwarded; unsupported → 400) | ✅ `language_code` (ISO 639-1; `auto` = omit) | — (auto-detect, no API field) | ✅ BCP-47 (`de`, `pt-BR`) or `auto` |
| `sample_rate` | — | ✅ | ✅ | — | — |
| `sound_effects` | — | ✅ (inside `voice_modify`) | — | — | — |

**MiniMax `voice_modify` and the PCM contract** (probed 2026-10-24): MiniMax refuses `voice_modify` for `format: pcm` outright ("voice modify does not support pcm format") and in **stream** mode only accepts mp3. A request carrying `voice_modify` is therefore rendered as a **buffered WAV** request and the RIFF header is stripped before the bytes enter nSpeech's PCM pipeline — same s16le 24 kHz mono contract, but no progressive first-byte. Unset `voice_modify` keeps the normal streaming PCM path.

### Local engine details

When `model: "nspeech"`, the actual engine behind the request is the one selected via the dashboard. Each has unique capabilities:

| Engine | Voices | Strengths | `extra_body` notes |
|--------|--------|-----------|--------------------|
| Kokoro | 54 built-in + cloned/blended | Most stable, reliable for long-form narration, ONNX-based (fast startup) | `blend` via voice mixing endpoint; no `batch` support |
| F5-TTS | cloned only (`<name>.wav` + `<name>.f5tts.txt` sidecar) | Primary GPU engine — bilingual EN/DE with per-request language routing | `speed`, `nfe_step`, `cfg_strength`, `sway_sampling_coef`, `seed`, `language` |
| Chatterbox Turbo | cloned only | English alternative to F5-TTS | `expressiveness` (mapped to `exaggeration`) |
| VibeVoice | cloned only | Multi-speaker dialogue (batch only, no streaming) | `voices: {1: "Alice", 2: "Bob"}`; script format `Speaker N: text` |

---

## 2. Voice Management — `/v1/voices`

Voice IDs are engine-scoped. Endpoints act on the engine specified by `?engine=` (use `nspeech`, `minimax`, `elevenlabs`, etc.). Omitting `?engine=` uses the current local engine.

### `GET /v1/voices`

```json
{
  "voices": [
    {"voice_id": "smart-lady", "name": "Smart Lady", "category": "preset", "voice_type": "preset", "engine": "gemini", "base_voice": "Kore", "instructions": "Speak in the cadence of a public intellectual."},
    {"voice_id": "Kore", "name": "Kore", "category": "builtin", "voice_type": "gemini_system", "engine": "gemini", "language": "auto", "description": "Warm"},
    {"voice_id": "my_voice", "name": "my_voice", "category": "cloned", "voice_type": "cloned", "engine": "minimax"}
  ]
}
```

Cloud adapters include `language`, `description`, `preview_url`, and `labels` where available. Kokoro voices include hexgrad quality-tier metadata (`targetQuality`, `overallGrade`) used by the dashboard to group/sort voices. All engines include Node-managed voice presets as `voice_type: "preset"`.

### `POST /v1/voices/preset`

Create or update a voice preset — a saved combination of a base voice and instructions. Works for all engines (local and cloud). JSON body:

```json
{"engine": "gemini", "id": "smart-lady", "name": "Smart Lady", "voice": "Kore", "instructions": "Speak in the cadence of a public intellectual."}
```

Returns `{"voice_id": "smart-lady", "name": "Smart Lady", "voice_type": "preset", "engine": "gemini", "base_voice": "Kore", "instructions": "..."}`.

Presets appear in `GET /v1/voices` alongside built-in and cloned voices. When used as the `voice` in a TTS request, the preset's `voice` and `instructions` override the request — the client does not need to repeat them. Presets are stored in `presets/<engine>.json` at the project root.

### `POST /v1/voices/clone`

Multipart: `name`, `audio` (wav/mp3/...), `prompt_text` (optional), `model` (optional).

```json
{"voice_id": "my_voice", "name": "my_voice", "category": "cloned", "engine": "minimax"}
```

### `POST /v1/voices/preview`

Same multipart shape as clone, but voice is not persisted. Returns streaming MP3 audio so the client can hear the cloned voice before saving. ElevenLabs and MiniMax clone to a temporary voice, generate preview, then discard.

### `POST /v1/voices/mix`

```json
{"name": "my_blend", "voice_a": "af_heart", "voice_b": "af_bella", "ratio": 0.5}
```

Kokoro only. Cloud adapters return an error.

### `DELETE /v1/voices/:voice_id`

Removes the voice. Cloud adapters call the provider's delete endpoint.

---

## 3. Engine Switch — `POST /v1/admin/engine`

```json
{"engine": "f5tts"}
```

Selects the engine the **dashboard** works with. For a local GPU engine this is
a real switch (unload the resident one, load the new one). For a **cloud**
engine it is a context change only: nothing is unloaded, nothing is loaded, and
the client default does not move.

Returns SSE stream of status events:

```
event: status   data: {"stage":"unload_start","engine":"kokoro"}
event: status   data: {"stage":"unload_done","engine":"kokoro"}
event: status   data: {"stage":"load_start","engine":"f5tts"}
event: status   data: {"stage":"load_done","engine":"f5tts"}
event: result   data: {"engine":"f5tts","status":"switched"}
```

Cloud engines emit a single `switch_done` status event and a result with
`"status":"cloud_selected"` — they have no worker lifecycle, and the resident
local engine keeps its VRAM.

### Client default — `POST /v1/admin/default-engine`

```json
{"engine": "f5tts"}
```

Sets what `model: "nspeech"` (or an omitted model) resolves to, and what
`GET /health` reports. Separate from the switch above on purpose: a cloud test
in the dashboard must not silently become the default for every API client.
Changing it loads nothing — the default is a pointer, and a local engine starts
on the first request that needs it. Unknown engine → `404 engine_not_found`
listing the valid names. `GET /v1/admin/default-engine` returns
`{"engine":"<default>","dashboard":"<browsed>"}`.

### `GET /v1/models`

OpenAI-style model list. Everything usable **without switching engines**:

- `nspeech` — the **client default** engine
- Resident local engines (`gpu:false`, e.g. `kokoro`) — always available
- All cloud provider model slugs

GPU engines other than the client default are excluded (they require a switch),
and the default engine is flagged `default: true`.

Cloud model entries carry the engine's model catalog. Each entry:

| Field | Meaning |
|-------|---------|
| `id` | Public model slug — pass as the top-level `model` field |
| `engine` | Cloud provider id (`minimax`, `elevenlabs`, `gemini`, `xai`, `fish`) |
| `provider_model` | Native model name sent to the provider API |
| `label` | Display name (dashboard / docs) |
| `default` | `true` for the provider's default (a bare engine prefix aliases to it) |

```json
{
  "object": "list",
  "data": [
    { "id": "nspeech", "object": "model", "owned_by": "nspeech", "engine": "nspeech" },
    { "id": "kokoro", "object": "model", "owned_by": "nspeech", "engine": "kokoro" },
    {
      "id": "minimax_speech_2_8_hd",
      "object": "model",
      "owned_by": "minimax",
      "engine": "minimax",
      "provider_model": "speech-2.8-hd",
      "label": "MiniMax Speech 2.8 HD",
      "default": false
    }
  ]
}
```

**Selecting a model** — the top-level `model` field accepts:

| Value | Result |
|-------|--------|
| `"nspeech"` | The **client default** engine (`POST /v1/admin/default-engine`) |
| Local engine name (`"kokoro"`) | That resident local engine |
| Cloud bare prefix (`"minimax"`) | The provider's default model |
| Cloud model slug (`"minimax_speech_2_8_hd"`) | That specific model |
| Legacy alias (`"elevenlabs_turbo_v2_5"`) | Resolves to its canonical model |

`extra_body.model` overrides the sub-model with a provider-native id (e.g. `"speech-2.8-hd"`) when you don't want the full-slug form.

**SDK** (`lib/nspeech-client/nspeech-client.js`): `NSpeechClient.listModels()` returns the full model list; `NSpeechClient.listEngineModels(engine)` filters it to a single engine (the dashboard uses this to populate model selectors). See [SDK_REFERENCE.md](SDK_REFERENCE.md) for the full client reference.

### `GET /v1/admin/engines`

```json
{
  "current": "kokoro",
  "default": "f5tts",
  "engines": [
    {"name": "f5tts", "type": "local", "gpu": true, "venv_exists": true, "is_current": false, "is_default": true, "is_loaded": true},
    {"name": "kokoro", "type": "local", "gpu": false, "venv_exists": true, "is_current": false, "is_default": false, "is_loaded": false},
    {"name": "minimax", "type": "cloud", "models": [{"id": "minimax_speech_2_8_turbo", "provider": "speech-2.8-turbo", "label": "MiniMax Speech 2.8 Turbo", "default": true}], "defaultModel": "minimax_speech_2_8_turbo", "health": "ready", "is_current": true, "is_default": false, "is_loaded": true}
  ]
}
```

`current` is the engine the dashboard is working with; `default` is the client
default. `is_current` / `is_default` flag the same split per entry.

---

## 4. Speech-to-Text — `POST /v1/audio/transcriptions`

Transcribe an audio file with faster-whisper large-v3 (int8, CPU). First request lazily spawns the STT worker (~10–60s cold start while models load; ~1–3s warm).

### Request (multipart)

| Part | Type | Required | Description |
|------|------|----------|-------------|
| `file` | file | **yes** | Audio bytes. WAV/FLAC/MP3/Ogg or raw PCM — compressed containers are ffmpeg-decoded server-side. |
| `language` | field | no | ISO-639-1 code. Omit for auto-detect. |
| `word_timestamps` | field | no | `"true"` to include per-word timestamps. |

```bash
curl -X POST http://127.0.0.1:2233/v1/audio/transcriptions \
  -F "file=@audio.wav" \
  -F "word_timestamps=true"
```

### Response

```json
{
  "text": "A data model fixed. Each choice is a door closing.",
  "language": "en",
  "duration": 12.0,
  "segments": [{"text": "...", "start": 0.0, "end": 5.2, "words": [{"word": "A", "start": 0.0, "end": 0.08}]}],
  "words": [{"word": "A", "start": 0.0, "end": 0.08}]
}
```

Word timestamps on transcription are **unconstrained ASR output** — whisper may drop or hallucinate words on hard audio. If you know the text and need guaranteed word↔time correspondence, use `/v1/audio/align`.

---

## 5. Forced Alignment — `POST /v1/audio/align`

Align **known text** to audio with torchaudio MMS_FA — wav2vec2 CTC forced alignment (multilingual, ~1100 languages incl. DE/EN). The Viterbi path is constrained to the given text: **words cannot be dropped, added, or hallucinated**. Output word count always equals `text.split().length`. This is what powers batch-stitch boundary trimming.

### Request (multipart)

| Part | Type | Required | Description |
|------|------|----------|-------------|
| `file` | file | **yes** | Audio bytes. WAV/FLAC/MP3/Ogg or raw PCM — compressed containers are ffmpeg-decoded server-side. |
| `text` | field | **yes** | The exact text spoken in the audio. |

```bash
curl -X POST http://127.0.0.1:2233/v1/audio/align \
  -F "file=@audio.wav" \
  -F "text=Der Korridor war eine Wahl und keine Notwendigkeit."
```

### Response

```json
{
  "text": "Der Korridor war eine Wahl und keine Notwendigkeit.",
  "duration": 4.2,
  "words": [
    {"word": "Der", "start": 0.08, "end": 0.24, "probability": 0.99},
    {"word": "Korridor", "start": 0.3, "end": 0.95, "probability": 0.98}
  ]
}
```

Timestamps resolve to 20ms frames (MMS emission stride). Text is uroman-romanized internally (umlauts, non-Latin scripts handled); words with no romanizable content (pure punctuation/numbers) collapse onto neighbors but keep their slot. **Caveat:** the audio must actually contain the given text — CTC alignment against mismatched audio produces smeared, meaningless spans (it will still "succeed"). Accuracy on clean speech: word boundaries to ~20–40ms.

---

## 6. Text Cleaning — `POST /v1/text/clean`

Speech-ready text cleaning as a standalone service. Use this when you need the exact text that will be spoken — e.g. to align against the rendered audio — then send the returned text to `/v1/audio/speech` with `extra_body.clean` unset.

### Request (JSON)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Raw text/markdown to clean. |
| `mode` | string | no | `'regex'` (default, fast/deterministic) or `'llm'` (regex + LLM prosody pass — **parked**, see Text Cleaning under `extra_body`). |

### Response

```json
{
  "text": "The optimizer didn't fail. It succeeded at the wrong goal.",
  "chars_before": 1234,
  "chars_after": 1100
}
```

Fails loud: 400 on missing `text` or invalid `mode`; 5xx if the LLM gateway is unreachable or the prosody pass refuses (coverage/compliance checks).

---

## 7. Errors

OpenAI-compatible shape:

```json
{"error": {"message": "...", "type": "invalid_request_error", "code": "voice_not_found", "param": "voice"}}
```

| HTTP | `type` | `code` | When |
|------|--------|--------|------|
| 400 | `invalid_request_error` | `missing_input`, `invalid_request`, `blend_not_supported`, `blend_failed` | Missing/invalid input, bad format, old local engine name (use `"nspeech"`) |
| 404 | `invalid_request_error` | `voice_not_found`, `model_not_found` | Voice/model/engine not found |
| 409 | `invalid_request_error` | `engine_busy` | Engine switch while requests active |
| 429 | `rate_limit_exceeded` | `rate_limit_exceeded` | Cloud provider rate limit |
| 500 | `engine_error` | `unknown` | Engine failed during generation |
| 502 | `engine_error` | `empty_audio`, `worker_error` | Engine produced no audio at all |
| 503 | `service_unavailable` | `worker_unavailable`, `engine_start_failed`, `engine_error`, `unknown` | Worker crashed / starting / cloud unavailable |

### Voices

`voice` is optional. Omitted or `"default"` is the **engine-default sentinel**: each
engine substitutes its own default voice (Kokoro: `af_heart`; Chatterbox: its loaded
voice). An engine with no default carries on to its own generation step.

A voice the engine cannot resolve is always `404 voice_not_found` — never a 500 and
never a `200` with an empty body. The check runs before any audio is produced, so a
bad voice costs no render quota.

**Validated at the request, not at synthesis.** `voice` is checked against the
resolved engine before dispatch, on the final value (after server defaults and preset
resolution), so a stale name is rejected immediately instead of surfacing mid-batch:

- **Shape check** — where the provider's own id format is verified: ElevenLabs voice
  ids are exactly 20 alphanumeric characters, so `"Kimi"` (a Kokoro-style name) is a
  404 naming the expected shape rather than an ElevenLabs round-trip.
- **Catalogue check** — where nSpeech owns the list: Gemini (30 prebuilt voices) and
  the local engines (`kokoro`, `f5tts`, `f5tts-german`, `chatterbox-turbo`,
  `vibevoice`). The error names the valid voice ids.
- **Not checked** — ElevenLabs membership (its adapter lists personal voices only,
  so the 20 premade voices that synthesise fine are not in it), MiniMax, xAI and Fish
  (account-scoped lists whose id rules are unverified). Their own 404 is mapped to
  the same `voice_not_found`.
- An empty catalogue proves nothing and never rejects: the request proceeds to the
  engine and a warning is logged.

---

## 8. Examples

```bash
# Local engine (whatever dashboard selected) — generate MP3
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"nspeech","input":"Hello.","voice":"af_heart","response_format":"mp3"}' \
  --output out.mp3

# MiniMax — stream MP3 with specific voice
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"minimax","input":"Hello.","voice":"English_expressive_narrator","response_format":"mp3"}' \
  --output out.mp3

# ElevenLabs — generate with voice settings
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"elevenlabs","input":"The first move sets everything in motion.","voice":"JBFqnCBsd6RMkjVDRZzb","extra_body":{"stability":0.3,"expressiveness":0.7}}' \
  --output out.mp3

# Create a voice preset
curl -X POST http://127.0.0.1:2233/v1/voices/preset \
  -H "Content-Type: application/json" \
  -d '{"engine":"gemini","id":"smart-lady","name":"Smart Lady","voice":"Kore","instructions":"Speak in the cadence of a public intellectual."}'

# Generate with a preset (auto-resolves to base voice + instructions)
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","input":"Hello.","voice":"smart-lady","response_format":"mp3"}' \
  --output out.mp3

# Clone a voice
curl -X POST http://127.0.0.1:2233/v1/voices/clone?engine=minimax \
  -F "name=my_voice" -F "audio=@reference.wav"

# Switch engine
curl -N -X POST http://127.0.0.1:2233/v1/admin/engine \
  -H "Content-Type: application/json" -d '{"engine":"minimax"}'

# List engines
curl http://127.0.0.1:2233/v1/admin/engines

# Live event stream
curl -N http://127.0.0.1:2233/v1/admin/events

# Transcribe audio (auto-detect language, word timestamps)
curl -X POST http://127.0.0.1:2233/v1/audio/transcriptions \
  -F "file=@audio.wav" -F "word_timestamps=true"

# Forced alignment — known text, guaranteed word count
curl -X POST http://127.0.0.1:2233/v1/audio/align \
  -F "file=@audio.wav" -F "text=A data model fixed. Each choice is a door closing."

# Long-form stitching (seamless joints, overlap-trimmed)
curl -X POST http://127.0.0.1:2233/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"elevenlabs","input":"<6000 chars of text...>","voice":"JBFqnCBsd6RMkjVDRZzb","extra_body":{"mode":"stitch"}}' \
  --output long.mp3

# One-shot clone + generate
curl -X POST "http://127.0.0.1:2233/v1/audio/speech/clone?engine=minimax&response_format=mp3" \
  -F "name=temp" -F "audio=@reference.wav" -F "text=Hello from my cloned voice." \
  --output out.mp3

# Manager status
curl http://127.0.0.1:2233/v1/admin/status
```
