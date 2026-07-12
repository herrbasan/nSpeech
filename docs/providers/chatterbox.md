# Chatterbox — Local TTS Engine

**Model:** [Chatterbox](https://github.com/resemble-ai/chatterbox) by Resemble AI  
**Architecture:** Zero-shot voice cloning TTS with conditional embeddings  
**Parameters:** 350M (turbo), 500M (eng/mtl)  
**License:** MIT  
**Inference:** PyTorch (native)  
**Output:** 24 kHz s16le mono PCM  
**GPU:** CUDA required

> Chatterbox is a family of state-of-the-art open-source TTS models by Resemble AI. Three variants are integrated into nSpeech, each as a separate engine entry: `chatterbox-turbo` (350M, English, paralinguistic tags), `chatterbox-eng` (500M, English, exaggeration tuning), and `chatterbox-mtl` (500M, 23 languages). All three share one venv but have separate voice directories. Voice cloning is the core feature — every voice is cloned from reference audio.

---

## Model Variants

| Variant | Parameters | Languages | Key Features | Use Case |
|---------|-----------|-----------|--------------|----------|
| **chatterbox-turbo** | 350M | English | Paralinguistic tags (`[laugh]`, `[cough]`, `[chuckle]`), lowest compute/VRAM, 1-step decoder | Voice agents, production |
| **chatterbox-eng** | 500M | English | Exaggeration & CFG weight tuning, expressive control | General zero-shot TTS with creative controls |
| **chatterbox-mtl** | 500M | 23 languages | Multilingual, cross-language voice cloning, V3 (latest) | Global applications, localization |

### Chatterbox Multilingual V3

Latest release (2026). Improvements over V2:
- More consistent speaker similarity across languages
- Reduced hallucination (less unwanted continuation/repetition)
- More natural conversational speech
- Single Language Pack: dedicated finetunes for priority languages (Chinese, Latam Spanish, Brazilian Portuguese, Spain Spanish, Portugal Portuguese, Hindi)

---

## Languages (chatterbox-mtl)

23 languages supported by the multilingual model:

Arabic (ar) • Danish (da) • German (de) • Greek (el) • English (en) • Spanish (es) • Finnish (fi) • French (fr) • Hebrew (he) • Hindi (hi) • Italian (it) • Japanese (ja) • Korean (ko) • Malay (ms) • Dutch (nl) • Norwegian (no) • Polish (pl) • Portuguese (pt) • Russian (ru) • Swedish (sv) • Swahili (sw) • Turkish (tr) • Chinese (zh)

Language codes are passed via the `language` parameter in `extra_body`.

---

## nSpeech Integration

### Engine Names

Three separate entries in `registry.json`:
- `chatterbox-turbo`
- `chatterbox-eng`
- `chatterbox-mtl`

Each spawns a separate worker process. All three share the same venv (`venv/chatterbox/env/`) but have **separate voice directories** (`venv/chatterbox-{turbo,eng,mtl}/voices/`).

### Voice Cache

| Type | Format | Location |
|------|--------|----------|
| Cloned | `.pt` file (Conditionals object) | `voices/<name>.pt` |

All three variants use the same `.pt` extension — no cross-model confusion because each engine has its own voice directory.

### Cloning

**Supported.** Chatterbox's core feature. The adapter extracts conditional embeddings from reference audio via `model.prepare_conditionals()`.

```python
model.prepare_conditionals(audio_path, exaggeration=0.5)
model.conds.save(cache_path)
```

The cloned voice is saved as a `.pt` file containing the `Conditionals` object. On subsequent `generate()` calls, the adapter loads the conditionals into the model:

```python
model.conds = Conditionals.load(cache_path, map_location=device)
```

### Voice Mixing

**Not supported.** Chatterbox doesn't expose a voice blending mechanism like Kokoro's tensor averaging.

---

## Generation Parameters

| Parameter | Type | Range | Default | Description |
|-----------|------|-------|---------|-------------|
| `exaggeration` | float | 0.0–1.0 | 0.5 | Delivery intensity. Higher = more dramatic/stylized. Maps to `exaggeration` in the adapter. |
| `language` | string | ISO-639-1 | `en` | Language code for `chatterbox-mtl`. Ignored by turbo/eng. |

### chatterbox-turbo

- No `exaggeration` parameter (turbo doesn't use CFG)
- Supports paralinguistic tags in text: `[laugh]`, `[cough]`, `[chuckle]`, `[sigh]`, `[gasp]`, etc.
- Fastest variant (1-step decoder, 350M params)

### chatterbox-eng

- `exaggeration` controls expressiveness (0.0 = flat, 1.0 = highly dramatic)
- Higher exaggeration tends to speed up speech; compensate with lower CFG weight if needed

### chatterbox-mtl

- `exaggeration` + `language` parameters
- Language codes: `de`, `es`, `fr`, `it`, `ja`, `ko`, `zh`, `ru`, `ar`, `da`, `el`, `fi`, `he`, `hi`, `ms`, `nl`, `no`, `pl`, `pt`, `sv`, `sw`, `tr`, `en`
- Friendly aliases supported: `german`, `english`, `spanish`, etc.

---

## Architecture Details

### Zero-Shot Voice Cloning

Chatterbox clones voices by extracting **conditional embeddings** from reference audio. Unlike dots.tts (which uses the reference audio directly at inference), Chatterbox extracts a fixed representation that can be reused across multiple generations without re-processing the reference.

The `Conditionals` object contains:
- Speaker embedding (voice identity)
- Prosody conditioning (rhythm, intonation patterns)
- Acoustic features for the vocoder

### Model Architecture

All three variants are based on:
- **Speech tokenization** via S3Tokenizer
- **Autoregressive backbone** (Llama 3-inspired)
- **HiFT-GAN** vocoder
- **PerTh watermarking** — imperceptible neural watermarks survive MP3 compression and audio editing

### Turbo vs Eng vs Mtl

- **Turbo (350M):** Distilled speech-token-to-mel decoder (10 steps → 1 step). Paralinguistic tags are native. Optimized for low-latency voice agents.
- **Eng (500M):** Full CFG (classifier-free guidance) with `exaggeration` and `cfg_weight` tuning. More expressive control.
- **Mtl (500M):** V3 multilingual checkpoint. Same architecture as eng but trained on 23 languages. Supports `language_id` parameter.

---

## Performance

- **TTFA:** Turbo is fastest (350M, 1-step decoder). Eng/mtl are slower (500M, multi-step).
- **RTF:** All three are GPU-bound. Turbo approaches real-time on modern CUDA GPUs.
- **VRAM:** Turbo ~4-6 GB, eng/mtl ~6-8 GB (500M params + conditioning overhead)
- **Quality ranking:** nSpeech user preference: Kokoro > dots.tts > Chatterbox. Chatterbox is decent but has "some strange moments" (audible artifacts, unstable prosody).

---

## Tips (from Resemble AI)

### General Use
- Ensure reference clip matches the target language (otherwise accent transfer occurs)
- Default settings (`exaggeration=0.5`, `cfg_weight=0.5`) work well for most prompts
- For fast-speaking reference speakers, lower `cfg_weight` to ~0.3

### Expressive / Dramatic Speech
- Lower `cfg_weight` (~0.3) and increase `exaggeration` (~0.7+)
- Higher exaggeration speeds up speech; reduce `cfg_weight` to compensate

---

## Watermarking

All Chatterbox output includes **PerTh (Perceptual Threshold) watermarking** — imperceptible neural watermarks that survive MP3 compression, audio editing, and common manipulations. Detection accuracy is nearly 100%.

```python
import perth
import librosa

watermarker = perth.PerthImplicitWatermarker()
audio, sr = librosa.load("output.wav", sr=None)
watermark = watermarker.get_watermark(audio, sample_rate=sr)
# 0.0 = no watermark, 1.0 = watermarked
```

---

## Links

| Resource | URL |
|----------|-----|
| GitHub repo | https://github.com/resemble-ai/chatterbox |
| Demo (HuggingFace Space) | https://huggingface.co/spaces/ResembleAI/Chatterbox-Multilingual-TTS |
| Demo page | https://resemble-ai.github.io/chatterbox_demopage/ |
| Discord | https://discord.gg/rJq9cRJBJ6 |
| PerTh watermarking | https://github.com/resemble-ai/perth |
| Evaluation (Turbo) | https://podonos.com/resembleai/chatterbox |
