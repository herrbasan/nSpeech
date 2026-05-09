# CosyVoice 3 Integration Notes

## Status (2026-05-09)
Adapter operational. CosyVoice3-0.5B works with cloned voices and cross-lingual generation.
Known limitation: 0.5B model has inconsistent prosody (variable speaking rate per sentence).
1.5B model not yet released — expected to fix prosody.

## Critical Dependency Versions
- `transformers==4.51.3` (NOT 5.x - causes dtype mismatch with safetensors/llm.pt mixed dtypes)
- `tokenizers==0.21.0` (required by transformers 4.51.3)
- `huggingface-hub==0.30.0` (required by transformers 4.51.3)
- `setuptools<70` (pkg_resources needed by pyworld, openai-whisper)
- `gdown==5.1.0`, `pyarrow==18.1.0` (missing from original CosyVoice requirements)

## GPU Setup
- `onnxruntime-gpu>=1.21.0` (not CPU onnxruntime)
- RTX 5090 (Blackwell, sm_120) needs PyTorch nightly with CUDA 12.8
- Install script uses `cu126` index; Blackwell users must override to `cu128`
- When installing `openai-whisper` on Python 3.13, use `pip install git+https://github.com/openai/whisper.git`

## Inference Architecture (V3 Adapter)

### Default/Cloned Voice Path
- **Method**: `inference_instruct2`
- **Prompt**: `"You are a helpful assistant.<|endofprompt|>"`
- **Stream**: `False` (per-sentence chunking provides progressive delivery)
- **Text frontend**: `False` (bypass wetext, raw text to Qwen3 tokenizer)
- **Sliding window**: Disabled (`use_sliding_window=False`) for attention stability

### Instruct/Language Path
- **Method**: `inference_instruct2`
- **Prompt**: `"{instruct_text}<|endofprompt|>"` or `"Speak in {lang}.<|endofprompt|>"`
- Temporarily swaps spk2info prompt_text for cloned voices

### What Fails
- `inference_zero_shot` + Chinese prompt wav → English text = gibberish (Chinese phonetics)
- `inference_cross_lingual` + per-sentence texts → assertion crash (missing `<|endofprompt|>` in segments)
- CosyVoice internal `stream=True` → hift STFT cache artifacts cause garbled audio

### Required Token
`<|endofprompt|>` (token ID 151646) MUST be in the LLM's prompt_text for every inference call.
The Qwen3-based CosyVoice3LM asserts this.

## Per-Sentence Chunking
Adapter uses regex sentence splitting with `stream=False` per sentence:
- Each sentence gets a clean, full-quality inference call
- Sentences yield progressively (TTFA ~1.5s for first chunk)
- No hift vocoder boundary artifacts (each call is separate)
- `text_frontend=False` prevents CosyVoice from re-splitting already-chunked text

## Voice Cloning
- Max audio duration: 30 seconds (CosyVoice3 asserts on longer audio)
- Clone prompt: `"You are a helpful assistant.<|endofprompt|>"` (clean, no trailing text)
- Cache: `torch.save(spk2info_data, cache_path)` / `torch.load(cache_path, weights_only=False, map_location='cpu')`
- Preview: in-memory clone via `/voices/preview`, no disk persistence

## Monkeypatches
- `torchaudio.load` → `soundfile.read` (bypasses torchcodec FFmpeg DLL requirement)
- `torchaudio.save` → `soundfile.write` (same reason)
- Applied at module level before any CosyVoice imports

## Runtime Warnings (Harmless)
- `Sliding Window Attention` — from Qwen3 backbone, disabled via config
- `torch.cuda.amp.autocast` deprecation — CosyVoice3 uses old API, fp16=False so never activated
- ONNX Memcpy warnings — from campplus/speech_tokenizer ONNX models on GPU

## Voice Management
- Saved voices: `{voice_dir}/{name}.wav` + `{voice_dir}/{name}.cosyvoice.pt`
- Previews: in-memory spk2info only, cleared on server restart
- Delete: removes .wav, .pt files, and spk2info entry

## Known Prosody Issues (0.5B Model)
- Variable speaking rate per sentence (some sentences slow, others fast)
- Odd pauses on short phrases (~2-word sentences get disproportionately long audio)
- Consistent across cold starts (model-level, not runtime nondeterminism)
- Not fixable at adapter level — 1.5B model is the expected solution
