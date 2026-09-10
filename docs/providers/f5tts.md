# F5-TTS — Local TTS Engine

**Model:** [F5-TTS](https://github.com/SWivid/F5-TTS) by SWivid (SJTU X-LANCE / Shanghai AI Lab)
**Architecture:** Flow matching + Diffusion Transformer with ConvNeXt V2. Non-autoregressive.
**License:** **code MIT; pre-trained weights CC-BY-NC.** The models inherit the non-commercial terms of the Emilia training dataset, as stated upstream. This covers the base checkpoints too, not only the German fine-tune.
**Inference:** PyTorch (CUDA)
**Output:** 24 kHz s16le mono PCM — matches nSpeech's standard, no resampling
**GPU:** CUDA required — roughly 3–4 GB with both checkpoints resident (nSpeech measurement)
**German fine-tune:** [aihpi/F5-TTS-German](https://huggingface.co/aihpi/F5-TTS-German) by HPI (Hasso-Plattner-Institut) — `cc-by-nc-4.0`, fine-tuned on Common Voice + Emilia_DE

> F5-TTS is nSpeech's **primary GPU engine** — user verdict 2026-08-16: "fast and better than Chatterbox". It is non-autoregressive, so it cannot hallucinate or loop, and it clones from a 5–15 s reference with **no embedding-extraction step**: the reference audio + its transcript are passed to every generation call. nSpeech runs it **bilingually** — see below.

---

## The two-checkpoint bilingual design

nSpeech runs **two F5 checkpoints side by side, one per language**, and routes each request to the right one. This is not two engines duplicating work — it exists because the base model on German produced "sudo German" (English phonetics forced onto German text, gibberish-adjacent), so a German fine-tune was adopted for DE while the base model stays for EN.

| Slot | Checkpoint | Source | Purpose |
|------|-----------|--------|---------|
| `en` | `F5TTS_v1_Base` | HuggingFace (upstream default) | English — the base model |
| `de` | `model_420000.safetensors` | `aihpi/F5-TTS-German` (HPI fine-tune) | German — the fine-tune |

### How routing works

1. **`extra_body.language: "de" | "en"`** — explicit, always wins.
2. Otherwise **`detect_language(text)`** — a zero-dependency weighted heuristic:
   - each `ä`/`ö`/`ü`/`ß` occurrence → **+2** (weighted, never decisive: one loanword such as *Übermensch* in English prose must not flip the render)
   - each unambiguous German function word (`der`, `die`, `das`, `und`, `nicht`, `ist`, …) → **+1**
   - each English function word (`the`, `and`, `of`, `is`, …) → **+1**
   - tie → **English** (the base model)

   This replaced an earlier version that short-circuited on a single umlaut and sent English text quoting German philosophy through the German checkpoint.

### Both checkpoints stay resident

`_get_model(lang)` lazy-loads on first use and keeps both in `self._models` — switching language between requests costs nothing. `F5TtsAdapter.preload()` warms **both** at worker start, so the first request of either language pays no load cost.

### Per-language guidance

`cfg_strength` defaults differ per checkpoint family, tuned by ear:

| Language | `cfg_strength` | Why |
|----------|----------------|-----|
| `en` | **2.5** | Tightens the "scattered" timbre vs 1.5 |
| `de` | **1.5** | 2.5 over-guides → an audible **metallic sheen** |

The German metallic sheen was long blamed on the vocoder. It was over-guidance in the decoder. An explicit `extra_body.cfg_strength` always overrides the default.

---

## Engine entries

| Registry name | Checkpoints | API-visible | Purpose |
|---------------|-------------|-------------|---------|
| `f5tts` | both, auto-routed | ✅ | The engine API clients use, for both languages |
| `f5tts-german` | German only (pinned) | ❌ `api_hidden` | Dashboard-only manual DE override |

Both entries share the same voice and model directories via `voice_dir` / `model_dir` overrides in `registry.json` — a voice cloned through one is visible to the other.

### Environment overrides (`registry.json` → `env`, resolved against the project root)

| Variable | Engine | Meaning |
|----------|--------|---------|
| `NSPEECH_F5_CKPT_DE` | `f5tts` | German checkpoint path |
| `NSPEECH_F5_MODEL_DE` | `f5tts` | German model config name (default `F5TTS_Base` = vocos) |
| `NSPEECH_F5_MODEL` | `f5tts-german` | Pins a single model config |
| `NSPEECH_F5_CKPT` | `f5tts-german` | Pins a single checkpoint path |

Setting `NSPEECH_F5_MODEL` puts the adapter in **explicit-engine mode**: one checkpoint, no routing.

---

## Voices

**No native catalog.** `list_voices()` returns `[]` — every F5 voice is user-created. A voice is a *pair* of files in `venv/f5tts/voices/`:

| File | Purpose |
|------|---------|
| `<name>.wav` | Reference audio (5–15 s) |
| `<name>.f5tts.txt` | Accurate transcript of that audio |

**Both are required.** The worker's directory scan skips a `.wav` with no `.f5tts.txt` sidecar — a bare wav is unusable. `server/voice-cache.js` mirrors that rule, so a half-cloned voice never appears in a listing.

## Cloning

`POST /v1/voices/clone` with reference audio and an optional `prompt_text`. The adapter:

1. Copies the reference into the voice directory.
2. **Trims to ~12 s** when longer — scanning for the quietest 50 ms window near the 12 s mark so the cut doesn't land mid-phoneme. F5 clips reference audio to ~12 s internally; storing a longer wav leaves the transcript mismatched, which distorts the chars/sec duration estimate and yields fast, oscillating speech.
3. Resamples to 24 kHz mono.
4. Auto-transcribes with faster-whisper when no `prompt_text` was given (a trim forces re-transcription).

## Generation parameters (`extra_body`)

| Param | Default | Notes |
|-------|---------|-------|
| `nfe_step` | `64` | ODE steps. `16` = faster, `64` = audiobook quality. `inference_steps` is accepted as an alias. |
| `speed` | `0.9` | **Duration divisor, not a playback rate** — `0.8` = 25 % longer/slower. |
| `cfg_strength` | `2.5` EN / `1.5` DE | Guidance strength. See above. |
| `sway_sampling_coef` | `-0.5` | Variation sampling — audibly smoother than `-1`. |
| `cross_fade_duration` | `0.15` | Seconds of cross-fade between internal chunks. |
| `target_rms` | `0.1` | Reference loudness-normalisation target. |
| `seed` | random | Set for deterministic output. |

## Streaming

`generate()` splits text with the library's own `chunk_text()` (~135-char batches on sentence boundaries), renders batches **sequentially**, and yields each the moment it completes — cross-faded against the held-back tail of the previous batch. First audio arrives after roughly one batch (~1–2 s) instead of after the full render.

Submitting all batches to a thread pool upfront does **not** lower time-to-first-byte: one CUDA context time-slices the concurrent batches, so every future completes at total-render time and the chunks arrive together at the end.

## Performance

> Timings below are nSpeech measurements (2026-08-16 / 2026-08-29, 4090).

- ~**4–7× real-time** on a 4090.
- `maxChars` is **`Infinity`** — nSpeech's chunking never triggers for F5; the adapter owns chunking end to end.
- Long-form verified: full articles (8.6 K and 14.2 K chars) render in ~1–2 min as 53–86 internal chunks with clean cross-fades.
- Fits the 4–6 GB TTS VRAM budget alongside the resident Kokoro.

## bigvgan (machinery kept, unused)

Support for running the German checkpoint on a BigVGAN vocoder exists (`NSPEECH_F5_MODEL_DE`, `_ensure_bigvgan_config()`, `third_party/BigVGAN`, `scripts/patch-bigvgan.py`) but the registry uses **vocos 420k**. The upstream German model card publishes both variants — `F5TTS_Base` (vocos) and `F5TTS_Base_bigvgan` — so this is a supported choice, not a hack. The BigVGAN detour turned out to be unnecessary: the metallic sheen was `cfg_strength`, not the vocoder. BigVGAN runs hotter, so the adapter peak-limits (> 0.95) to avoid clip distortion. Re-run `scripts/patch-bigvgan.py` after a venv reinstall if it is ever re-enabled.

## Notes

- Monotone intonation is the *reference's* register, not a model limitation — an expressive reference produces expressive output.
- `instructions` is not an F5 parameter; delivery comes from the reference audio.
- Trial history and the comparisons that led here: [docs/ENGINE_TRIALS.md](../ENGINE_TRIALS.md).
