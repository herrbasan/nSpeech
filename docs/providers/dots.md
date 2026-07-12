# dots.tts — Local TTS Engine

**Model:** [dots.tts](https://github.com/rednote-hilab/dots.tts) by RedNote (Xiaohongshu) AI Lab  
**Architecture:** 2B fully continuous end-to-end AR TTS (Qwen2.5-1.5B backbone + AR flow-matching DiT + 48 kHz AudioVAE)  
**Parameters:** 2 billion  
**License:** Apache-2.0  
**Inference:** PyTorch (native)  
**Output:** 48 kHz native → resampled to 24 kHz s16le mono PCM for nSpeech  
**GPU:** CUDA required (4-8 GB VRAM)

> dots.tts is a 2B-parameter fully continuous autoregressive TTS system with state-of-the-art performance on Seed-TTS-Eval. Unlike Chatterbox (which extracts embeddings) or Kokoro (which uses fixed voice styles), dots.tts uses the reference audio directly at inference time via a CAM++ speaker x-vector. Voice identity comes from the reference audio — no embedding extraction step. Three checkpoints share the same backbone: `base` (pretrained), `soar` (best cloning quality), and `mf` (MeanFlow distilled, fastest).

---

## Checkpoints

Three pretrained checkpoints on HuggingFace. All share the same 2B backbone — choose by quality/inference-cost tradeoff:

| Checkpoint | Description | NFE (steps) | Use Case |
|------------|-------------|-------------|----------|
| `rednote-hilab/dots.tts-base` | Pretrained checkpoint | 10–32 (default 10) | Baseline |
| `rednote-hilab/dots.tts-soar` | Self-corrective-aligned (SCA). Best voice cloning performance | 10–32 (default 10) | Highest quality |
| `rednote-hilab/dots.tts-mf` | MeanFlow-distilled student from soar. 4 NFE | 4 | Fast inference (recommended for nSpeech) |

**nSpeech default:** `dots.tts-mf` (4 NFE) — best speed/quality balance. Configurable via `NSPEECH_DOTS_CHECKPOINT` env var.

---

## Languages

24 languages supported (per MiniMax multilingual benchmark):

Highest average speaker similarity (83.9) on the benchmark. Takes per-language SIM lead on 19 of 24 languages.

**Note:** BPE backbone inherits Qwen2.5's language coverage. Higher WER on under-represented languages (Arabic, Hindi, Turkish, Vietnamese) but speaker similarity is preserved.

---

## nSpeech Integration

### Engine Name

`dots` — single engine entry in `registry.json`.

### Voice Cache

| Type | Format | Location |
|------|--------|----------|
| Cloned | `.wav` (reference audio) + `.dots.json` (sidecar with path + transcript) | `voices/<name>.wav` + `voices/<name>.dots.json` |

**dots.tts doesn't extract embeddings.** The reference audio IS the voice. Every `generate()` call receives the reference audio + transcript. The JSON sidecar stores:

```json
{
  "voice_name": "my_voice",
  "engine": "dots",
  "prompt_audio_path": "/path/to/voices/my_voice.wav",
  "prompt_text": "The transcript of the reference audio."
}
```

### Cloning

**Supported.** dots.tts uses **continuation voice cloning** — the reference audio + transcript are passed to every generation call. The adapter:

1. Copies reference audio to `voices/<name>.wav` (resampled to 24 kHz mono 16-bit)
2. Auto-transcribes with Whisper if no `prompt_text` provided
3. Saves JSON sidecar with path + transcript

```python
result = runtime.generate(
    text="Hello world.",
    prompt_audio_path="voices/my_voice.wav",
    prompt_text="The transcript of the reference audio.",
    num_steps=4,
    guidance_scale=1.2,
)
```

**X-vector-only cloning** (reference audio only, no transcript) also works but produces lower speaker similarity.

### Voice Mixing

**Not supported.** dots.tts doesn't expose a voice blending mechanism.

---

## Generation Parameters

| Parameter | Type | Range | Default | Description |
|-----------|------|-------|---------|-------------|
| `num_steps` | int | 1–32 | 4 (mf), 10 (base/soar) | Flow-matching sampling steps. Higher = better quality, slower. |
| `guidance_scale` | float | 0.0–3.0 | 1.2 | CFG scale. Higher = stick closer to voice clone. Values >2 amplify energy. |
| `seed` | int | any | 42 | Random seed. Same seed + same input = reproducible output. Different seeds produce different prosody/intonation. |
| `language` | string | — | `none` | Language tag: `EN`, `ZH`, `auto_detect`, or `none`. |

### nSpeech extra_body Mapping

| extra_body field | dots.tts parameter |
|------------------|-------------------|
| `inference_steps` | `num_steps` |
| `guidance_scale` | `guidance_scale` |
| `seed` | `seed` |
| `language` | `language` |

---

## Architecture Details

### Fully Continuous AR TTS

dots.tts is architecturally different from discrete-token TTS systems:

1. **AudioVAE** — frozen 48 kHz encoder/decoder. Encodes waveform into continuous latent, decodes back via BigVGAN-style causal decoder.
2. **Semantic encoder** — re-encodes each generated VAE patch into compact embedding for the LLM (strips high-variance acoustic detail)
3. **LLM** — Qwen2.5-1.5B-Base. Consumes BPE text directly (no phonemes), emits one hidden state per audio step
4. **AR flow-matching head** — DiT that conditions on LLM hidden state + AR prefix to denoise the next VAE patch. CAM++ speaker x-vector as side input.

**No discrete tokens anywhere in the pipeline.** The entire system operates in continuous latent space.

### Voice Cloning Mechanism

dots.tts uses a **CAM++ speaker x-vector** extracted from the reference audio at inference time. The x-vector is passed as side input to the flow-matching DiT. Unlike Chatterbox (which extracts and caches conditionals), dots.tts re-computes the x-vector from the reference audio on every generation call.

**Continuation cloning** (reference audio + transcript) produces the best speaker similarity. The transcript helps the model align the reference audio with the target text.

### Precision

**float32 required for streaming.** The `generate_stream()` path has a dtype bug in bfloat16 — `TimestepEmbedder` hardcodes float32 timestep embeddings and attention layers mix float32/bfloat16, crashing the AR loop after 0-1 patches.

The non-streaming `generate()` path works in bfloat16, but nSpeech uses float32 for reliable streaming.

### Optimization

`optimize=True` triggers `torch.compile` acceleration. Requires Triton (no Windows wheels). nSpeech disables on Windows, enables on Linux.

---

## Performance

### Benchmarks (from dots.tts paper)

**Seed-TTS-Eval** (zero-shot, ~3s reference):
- WER: 0.94% / 1.30% / 6.60% (zh / en / zh-hard)
- SIM: 81.0 / 77.1 / 79.5 (zh / en / zh-hard)
- **Best average performance** on Seed-TTS-Eval

**MiniMax Multilingual** (24 languages):
- Highest average SIM: 83.9 (SCA checkpoint)
- Per-language SIM lead on 19/24 languages

### Efficiency (with `--optimize`, H800)

| Checkpoint | Mode | RTF | First-chunk latency |
|------------|------|-----|---------------------|
| SOAR | voice_cloning | 0.21 | 225 ms |
| SOAR | text_only | 0.18 | 69 ms |
| MF | voice_cloning | 0.16 | 204 ms |
| MF | text_only | 0.13 | 68 ms |

**nSpeech (RTX 5090, mf checkpoint, float32):** RTF ~0.85-0.91 — realtime.

### Memory Footprint

| Audio length | VRAM (SOAR) | VRAM (MF) |
|--------------|-------------|-----------|
| <10s | 5.65 GB | 5.30 GB |
| <20s | 6.53 GB | 5.47 GB |
| <40s | 7.86 GB | 5.74 GB |
| <80s | 10.51 GB | 6.29 GB |

---

## Usage Tips (from dots.tts)

- **Reference audio:** Keep around 10s. Longer won't yield better results.
- **Transcript accuracy:** `prompt_text` should match what's actually spoken. Mismatches degrade stability.
- **Reference quality:** High sample rate, low background noise, no trailing noise, natural-sounding speech.
- **Seed variation:** Try different `seed` values for prosody variation. Each seed produces different rhythm/intonation.
- **Quality vs speed:** Increase `num_steps` if quality isn't good enough. More steps = cleaner output + better expressiveness.
- **Pronunciation:** Force pronunciation with Pinyin for polyphones (Chinese). Use tone-marked pinyin (`hǎo`, `hào`, `bā`).

---

## Known Issues

### Streaming Gaps

dots.tts streaming has **audible gaps between patches** — intrinsic to the AR model (each patch is denoised independently). Offline mode (`batch=True`) fixes this by rendering full audio before first byte.

**nSpeech dashboard:** "Offline mode" checkbox uses `runtime.generate()` instead of `generate_stream()`.

### Windows Compatibility

- `optimize=False` required (no Triton wheels on Windows)
- Auto-enables on Linux
- librosa.load() patched to use soundfile (audioread fails on certain WAV formats on Windows)

### WeTextProcessing

Patched to lazy import in `text.py` — pynini doesn't build on Windows. Text normalization disabled on Windows.

---

## Links

| Resource | URL |
|----------|-----|
| GitHub repo | https://github.com/rednote-hilab/dots.tts |
| HuggingFace checkpoints | https://huggingface.co/collections/rednote-hilab/dotstts |
| Technical report (arXiv) | https://arxiv.org/abs/2606.07080 |
| Demo (HuggingFace Space) | https://huggingface.co/spaces/rednote-hilab/dots.tts |
| Demo page | https://rednote-hilab.github.io/dots.tts-demo/ |
| Community projects | MLX port (Apple Silicon), ComfyUI nodes |
