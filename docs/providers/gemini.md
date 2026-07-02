# Gemini TTS — Speech Provider

**Base URL:** `https://generativelanguage.googleapis.com/v1alpha`  
**Endpoint:** `POST /models/{model}:interactions.create`  
**Auth:** `x-goog-api-key: <API_KEY>` (header, NOT `Authorization: Bearer`)  
**API Key source:** [Google AI Studio > API Keys](https://aistudio.google.com/apikey)  
**Playground:** [AI Studio TTS](https://aistudio.google.com/app/apps/bundled/synergy_intro)

> Gemini TTS is fundamentally different from every other provider. It's an **LLM that generates audio tokens**, not a traditional TTS pipeline. The model reads a prompt (which can include director's notes, scene descriptions, and audio tags) and produces speech. This means style control is driven by *natural language*, not parameter sliders. There is no voice cloning, no speed slider, no stability/exaggeration knobs — you write a prompt, pick a voice, and let the model act.

---

## Models

| Model | Input / 1M tokens | Output / 1M tokens | Streaming | Free tier |
|-------|-------------------|---------------------|-----------|-----------|
| `gemini-3.1-flash-tts-preview` | $1.00 | $20.00 | ✅ | ✅ |

**nSpeech default:** `gemini-3.1-flash-tts-preview` — latest, supports streaming.

Legacy models (consider migrating):
| `gemini-2.5-flash-preview-tts` | $0.50 | $10.00 | ❌ | ✅ |
| `gemini-2.5-pro-preview-tts` | $1.00 | $20.00 | ❌ | ❌ (paid only) |

Audio output is billed at 25 tokens per second of audio. Text input is billed at standard text token rates.

---

## Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/models/{model}:interactions.create` | POST | Generate speech (single or multi-speaker) |
| `/models/{model}:interactions.create?stream=true` | POST | Streaming speech generation |

Unlike other providers, Gemini TTS has:
- **No separate voices endpoint** — voices are a static list of 30 names
- **No clone endpoint** — no voice cloning at all
- **No delete endpoint** — no custom voices to delete

---

## 1. Generate Speech — `POST :interactions.create`

### Request (REST)

```json
POST /v1alpha/models/gemini-3.1-flash-tts-preview:interactions.create
x-goog-api-key: <key>
Content-Type: application/json

{
  "input": "Say cheerfully: Have a wonderful day!",
  "response_format": {"type": "audio"},
  "generation_config": {
    "speech_config": [
      {"voice": "Kore"}
    ]
  }
}
```

### Key Fields

| Field | Required | Notes |
|-------|----------|-------|
| `input` | ✅ | The prompt. Can include `Say cheerfully:`, director's notes, audio tags like `[whispers]`. |
| `response_format.type` | ✅ | Must be `"audio"` for TTS. |
| `generation_config.speech_config` | ✅ | Array of voice configs. Single element for single-speaker, two for multi-speaker. |
| `speech_config[].voice` | ✅ | One of 30 voice names (see below). |
| `speech_config[].speaker` |  | Speaker name matching the prompt. Only needed for multi-speaker. |

### Single-Speaker

```json
{
  "input": "Say in a spooky whisper: By the pricking of my thumbs, something wicked this way comes.",
  "response_format": {"type": "audio"},
  "generation_config": {
    "speech_config": [{"voice": "Enceladus"}]
  }
}
```

### Multi-Speaker (up to 2)

```json
{
  "input": "Speaker1: How's it going today?\nSpeaker2: Not too bad, how about you?",
  "response_format": {"type": "audio"},
  "generation_config": {
    "speech_config": [
      {"speaker": "Speaker1", "voice": "Kore"},
      {"speaker": "Speaker2", "voice": "Puck"}
    ]
  }
}
```

### Response (non-streaming)

```json
{
  "output_audio": {
    "data": "<base64-encoded PCM audio>"
  }
}
```

The `output_audio.data` field contains base64-encoded PCM (s16le, 24kHz, mono). Decode and pipe into `pipePcmToClient`.

### Response (streaming — 3.1 Flash TTS only)

Streaming returns SSE-style events. Each `step.delta` event with `delta.type === "audio"` contains a base64 PCM chunk:

```json
{"event_type": "step.delta", "delta": {"type": "audio", "data": "<base64 chunk>"}}
{"event_type": "step.delta", "delta": {"type": "audio", "data": "<base64 chunk>"}}
{"event_type": "step.finish"}
```

**nSpeech integration:** For non-streaming, decode the full base64 blob → Buffer → `Readable.from([buf])`. For streaming (3.1 only), accumulate chunks and push as they arrive.

### Error Responses

```json
{
  "error": {
    "code": 400,
    "message": "Invalid voice name: InvalidVoiceName",
    "status": "INVALID_ARGUMENT"
  }
}
```

Common errors:
- `PROHIBITED_CONTENT` — prompt was rejected by safety classifier. Try adding a clear preamble like `"Say:"`
- `InvalidVoiceName` — voice name doesn't match any of the 30 available
- `500` — model randomly returned text tokens instead of audio (rare, retry)

---

## 2. Voices

30 named voices, static list (no API endpoint to query them):

| Voice | Character | Voice | Character | Voice | Character |
|-------|-----------|-------|-----------|-------|-----------|
| Zephyr | Bright | Puck | Upbeat | Charon | Informative |
| Kore | Firm | Fenrir | Excitable | Leda | Youthful |
| Orus | Firm | Aoede | Breezy | Callirrhoe | Easy-going |
| Autonoe | Bright | Enceladus | Breathy | Iapetus | Clear |
| Umbriel | Easy-going | Algieba | Smooth | Despina | Smooth |
| Erinome | Clear | Algenib | Gravelly | Rasalgethi | Informative |
| Laomedeia | Upbeat | Achernar | Soft | Alnilam | Firm |
| Schedar | Even | Gacrux | Mature | Pulcherrima | Forward |
| Achird | Friendly | Zubenelgenubi | Casual | Vindemiatrix | Gentle |
| Sadachbia | Lively | Sadaltager | Knowledgeable | Sulafat | Warm |

Voice names are case-sensitive. Match them exactly as listed.

---

## 3. Prompt Engineering (Style Control)

This is what makes Gemini TTS unique. Instead of parameter sliders for stability, expressiveness, etc., you control style through natural language prompts using three layers:

### Audio Tags

Inline modifiers placed directly in the text. Use English tags even for non-English transcripts:

| Tag | Effect |
|-----|--------|
| `[whispers]` | Whispered delivery |
| `[shouting]` | Loud, intense delivery |
| `[excitedly]` | Enthusiastic tone |
| `[bored]` | Flat, uninterested delivery |
| `[sarcastically]` | Ironic/sarcastic tone |
| `[very fast]` / `[very slow]` | Pace control |
| `[laughs]` | Laughter |
| `[gasp]` | Sharp intake of breath |
| `[sighs]` | Audible sigh |
| `[crying]` | Tearful delivery |
| `[cough]` | Cough interjection |
| `[like a cartoon dog]` | Character voice — anything creative |

Tags can be combined: `[sarcastically, one painfully slow word at a time] text`

### Prompt Structure (The "Director" Approach)

A well-crafted prompt has these components:

- **Audio Profile** — character name, role, archetype
- **Scene** — physical environment, mood, "vibe"
- **Director's Notes** — style, pacing, accent
- **Transcript** — the actual text to speak

Example full prompt:

```
# AUDIO PROFILE: Jaz R. — "The Morning Hype"

## THE SCENE: The London Studio
It's 10PM in a glass-walled studio overlooking the moonlit London skyline.
The red "ON AIR" tally light is blazing. Jaz is standing, bouncing to a
thumping backing track.

### DIRECTOR'S NOTES
Style: "Vocal smile" — bright, sunny, explicitly inviting.
Dynamics: High projection without shouting. Punchy consonants.
Pace: Energetic, bouncing cadence, no dead air.
Accent: Brixton, London

#### TRANSCRIPT
Yes, massive vibes in the studio! You are locked in and it is absolutely
popping off in London right now. Turn this up!
```

### Prompting Tips

- Add a preamble like `"Say cheerfully:"` to trigger speech synthesis (vague prompts may be rejected or read aloud)
- Match the voice to the desired style (Enceladus for breathy/soft, Puck for upbeat, Kore for firm)
- Don't overspecify — leave room for the model to act
- Align "who is saying it" with "what is said" and "how it is being said"

---

## 4. Supported Languages

The model auto-detects input language. **80+ languages** supported — far more than any other provider. Full list on [Google's page](https://ai.google.dev/gemini-api/docs/speech-generation#supported-languages).

Major languages include: English, Chinese (Mandarin), Japanese, Korean, French, German, Spanish, Portuguese, Arabic, Hindi, Russian, Italian, Turkish, Vietnamese, Thai, Polish, Dutch, Romanian, and many more.

For best results with audio tags, use English tags even in non-English transcripts.

---

## 5. Limitations

- **No voice cloning.** Period. Prompt-driven style only.
- **No speed parameter.** Control pace via audio tags and prompt direction.
- **No output format selection.** Always returns base64 PCM (s16le, 24kHz, mono). Transcoding is handled by nSpeech's ffmpeg layer.
- **32k token context window.** Sessions limited to 32k tokens.
- **Streaming:** Only on `gemini-3.1-flash-tts-preview`. 2.5 models are batch-only.
- **Quality drift:** Outputs longer than a few minutes may degrade. Split long text into chunks.
- **Random 500 errors:** Model occasionally returns text tokens instead of audio (~1% of requests). Implement retry logic.
- **Voice inconsistency:** Model output may not always strictly match the selected speaker voice. Align prompt tone with voice character.
- **No voice list endpoint.** Voice names are a static list — hardcode them.

---

## nSpeech Integration Notes

### PCM path

```
POST /v1alpha/models/gemini-3.1-flash-tts-preview:interactions.create
x-goog-api-key: KEY
{"input": "Say: text", "response_format": {"type": "audio"}, "generation_config": {"speech_config": [{"voice": "Kore"}]}}
→ JSON response with output_audio.data (base64 PCM)
→ decode base64 → Buffer → Readable.from([buf])
→ pipePcmToClient → ffmpeg transcode → MP3/Opus/AAC → client
```

### API shape differences

| OpenAI field | Gemini mapping |
|-------------|---------------|
| `model` | `gemini-3.1-flash-tts-preview` (as URL path segment) |
| `input` | `input` (wrapped with prompt directives) |
| `voice` | `speech_config[0].voice` |
| `speed` | Not supported — use audio tags `[very fast]` / `[very slow]` |
| `response_format` | Always PCM — nSpeech transcodes |
| `instructions` | Merged into `input` as director's notes |
| `extra_body` | Maps to `generation_config` and prompt enrichment |

### What to skip for now

- **Multi-speaker** — not relevant for nSpeech's single-voice use case. Can be exposed via `extra_body.speakers` later.
- **Streaming** — only on 3.1 model. Start with batch, add streaming later.
- **Prompt builder** — too complex for a simple dashboard. Users write raw prompts.
