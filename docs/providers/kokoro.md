# Kokoro — Local TTS Engine

**Model:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad  
**Architecture:** StyleTTS 2 (decoder-only, no diffusion, no encoder)  
**Parameters:** 82 million  
**License:** Apache-2.0 (model), MIT (kokoro-onnx runtime)  
**Inference:** [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) — ONNX Runtime (CPU + CUDA)  
**Canonical repo:** [hexgrad/kokoro](https://github.com/hexgrad/kokoro) (Python inference library)  
**G2P:** [misaki](https://github.com/hexgrad/misaki) — grapheme-to-phoneme library  
**Output:** 24 kHz s16le mono PCM  
**GPU:** CUDA (ONNX Runtime). Also runs on CPU. MPS on macOS.

> Kokoro is an open-weight TTS model with 82 million parameters. Despite its lightweight architecture, it delivers comparable quality to much larger models while being significantly faster and more cost-efficient. nSpeech uses the ONNX Runtime port (`kokoro-onnx`) for inference — no PyTorch dependency at runtime, fast startup, and CUDA acceleration. Kokoro is nSpeech's most stable and reliable engine.

---

## Model Versions

| Version | Date | Training data | Languages / Voices |
|---------|------|---------------|-------------------|
| v1.0 | 2025-01-27 | Few hundred hours | 9 languages, 54 voices |
| v0.19 | 2024-12-25 | <100 hours | 1 language, 10 voices |

**nSpeech uses v1.0** — model files: `kokoro-v1.0.onnx` + `voices-v1.0.bin`.

---

## Voices

54 built-in voices across 9 languages. Voice IDs follow the pattern `{lang_prefix}_{gender}_{name}`:
- `a` = American English, `b` = British English, `e` = Spanish, `f` = French
- `h` = Hindi, `i` = Italian, `j` = Japanese, `p` = Brazilian Portuguese, `z` = Mandarin Chinese

### American English (19 voices)

| Female | Male |
|--------|------|
| `af_alloy`, `af_aoede`, `af_bella`, `af_heart`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky` | `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck` |

### British English (8 voices)

| Female | Male |
|--------|------|
| `bf_alice`, `bf_emma`, `bf_isabella`, `bf_lily` | `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis` |

### Other Languages

| Language | Voices |
|----------|--------|
| 🇪🇸 Spanish | `ef_dora`, `em_alex`, `em_santa` |
| 🇫🇷 French | `ff_siwis` |
| 🇮🇹 Italian | `if_sara`, `im_nicola` |
| 🇯🇵 Japanese | `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro`, `jm_kumo` |
| 🇨🇳 Mandarin | `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi`, `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang` |
| 🇮🇳 Hindi | `hf_alpha`, `hm_omega`, `hm_psi` |
| 🇧🇷 Portuguese | `pf_dora`, `pm_alex`, `pm_santa` |

Full list: [Kokoro-82M/VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)

---

## nSpeech Integration

### Engine Name

`kokoro` — single engine entry in `registry.json`.

### Voice Cache

| Type | Format | Location |
|------|--------|----------|
| Built-in | Voice name string (resolved via `pipeline.get_voice_style()`) | In-memory |
| Cloned | `.pt` file (voice embedding tensor) | `voices/<name>.kokoro.pt` |
| Blended | `.pt` file (weighted average tensor) | `voices/<name>.kokoro.pt` |

### Cloning

**Stub.** Kokoro's ONNX runtime does not expose the style-extractor network needed for zero-shot voice cloning from reference audio. The `clone()` method saves a `.pt` containing the string `"af_heart"` as a fallback — it produces audio but does not clone the reference voice.

True cloning would require extracting a voice embedding from reference audio, which the ONNX model doesn't support.

### Voice Mixing

**Supported.** Kokoro's voice embeddings can be blended by weighted averaging of the tensors. nSpeech exposes this via `POST /v1/voices/mix`:

```json
{
  "name": "my_blend",
  "voice_a": "af_heart",
  "voice_b": "af_bella",
  "ratio": 0.5
}
```

The adapter computes `ratio * voice_a + (1 - ratio) * voice_b` and saves the result as a `.pt` cache file.

---

## Generation Parameters

| Parameter | Type | Range | Default | Description |
|-----------|------|-------|---------|-------------|
| `speed` | float | 0.5–2.0 | 1.0 | Speaking speed. Passed directly to `pipeline.create()`. |
| `voice_name` | string | — | `af_heart` | Built-in voice ID or cached voice name. |

Kokoro has minimal tunable parameters — no exaggeration, no diffusion steps, no guidance scale. The model is deterministic given a voice and speed.

---

## Architecture Details

### StyleTTS 2

Kokoro is based on [StyleTTS 2](https://arxiv.org/abs/2306.07691) by Li et al. Key characteristics:
- **Decoder-only** — no diffusion sampler, no encoder at inference time
- **ISTFTNet** vocoder ([paper](https://arxiv.org/abs/2203.02395))
- **82M parameters** — tiny compared to most TTS models
- **24 kHz** native sample rate
- **G2P via misaki** — grapheme-to-phoneme conversion handles English OOD words, with per-language fallbacks

### ONNX Runtime

nSpeech uses `kokoro-onnx` (not the original PyTorch `kokoro` package) for inference:
- Model: `kokoro-v1.0.onnx` (~300 MB)
- Voices: `voices-v1.0.bin` (all 54 voice embeddings)
- Runtime: ONNX Runtime with CUDA ExecutionProvider (falls back to CPU)
- Thread-safe: `Session.run()` is documented as thread-safe per ONNX Runtime docs

### Sentence Chunking

The adapter splits text on sentence boundaries (`(?<=[.!?])\s+`) and generates each sentence independently, yielding `(pcm_tensor, is_final)` per chunk. This enables streaming — the first sentence starts playing while later sentences are still generating.

---

## Performance

- **TTFA:** Sub-second for short text (sentence-level chunking means first audio arrives fast)
- **RTF:** Well under 1.0 on CUDA. Fast enough for real-time streaming.
- **VRAM:** Lightweight — Kokoro's 82M params fit easily in GPU memory alongside other workloads.
- **Quality ranking:** nSpeech's #1 engine for stability and consistency. Less "performing" than Chatterbox or dots.tts, but more reliable for long-form narration.

---

## Training

- **Data:** Exclusively permissive/non-copyrighted audio (public domain, Apache/MIT licensed, synthetic from closed-source TTS)
- **Cost:** ~$1,000 for 1,000 hours of A100 80GB training
- **Total dataset:** A few hundred hours
- **CC BY attributions:** Koniwa tnc (<1h, CC BY 3.0), SIWIS (<11h, CC BY 4.0)

---

## Links

| Resource | URL |
|----------|-----|
| Model (HuggingFace) | https://huggingface.co/hexgrad/Kokoro-82M |
| Canonical repo | https://github.com/hexgrad/kokoro |
| ONNX runtime (used by nSpeech) | https://github.com/thewh1teagle/kokoro-onnx |
| G2P library | https://github.com/hexgrad/misaki |
| Demo (HuggingFace Space) | https://hf.co/spaces/hexgrad/Kokoro-TTS |
| StyleTTS 2 paper | https://arxiv.org/abs/2306.07691 |
| ISTFTNet paper | https://arxiv.org/abs/2203.02395 |
| Voices list | https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md |
| Audio samples | https://huggingface.co/hexgrad/Kokoro-82M/blob/main/SAMPLES.md |
