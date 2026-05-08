# CosyVoice 3 Setup Notes

## Status
Adapter created but NOT committed. Needs separate venv (conflicts with Chatterbox/Kokoro on transformers version).

## Critical Dependency Versions
- `transformers==4.51.3` (NOT 5.x - causes dtype mismatch with safetensors/llm.pt mixed dtypes)
- `tokenizers==0.21.0` (required by transformers 4.51.3)
- `huggingface-hub==0.30.0` (required by transformers 4.51.3)

## Required Environment Variable
```
NUMBA_DISABLE_JIT=1
```
Prevents Windows deadlock during YAML loading in CosyVoice.

## Python Path Additions
Before importing CosyVoice, must add:
```
D:\Work\_GIT\nSpeech\models\third_party\CosyVoice
D:\Work\_GIT\nSpeech\models\third_party\CosyVoice\third_party\Matcha-TTS
```

## Inference Mode (CRITICAL)
- **Use `inference_instruct2` with `zero_shot_spk_id`** - WORKS
- **Do NOT use `inference_cross_lingual`** - FAILS in CosyVoice3
- **Do NOT use `inference_zero_shot` with `zero_shot_spk_id`** - produces tiny audio (~0.12s)

## Required Token
All text MUST end with `<|endofprompt|>` token:
```python
text = f"{text}<|endofprompt|>"
instruct_text = "You are a helpful assistant.<|endofprompt|>"
```

## Voice Cloning
- Max audio duration: 30 seconds (CosyVoice3 limitation)
- Must clip longer audio before cloning
```python
clipped_samples = 30 * sample_rate
torchaudio.save(clipped_path, wav[:, :clipped_samples], sr)
```
- Use: `model.add_zero_shot_spk(prompt_text, prompt_wav, voice_name)`

## Voice Cache Loading
```python
spk_data = torch.load(cache_path, weights_only=False, map_location='cpu')
```

## Working `_generate_cached_voice` Pattern
```python
def _generate_cached_voice(self, text: str, voice_name: str, speed: float):
    instruct_text = "You are a helpful assistant.<|endofprompt|>"
    for chunk in self.model.inference_instruct2(
        tts_text=text,
        instruct_text=instruct_text,
        prompt_wav="",
        zero_shot_spk_id=voice_name,
        stream=True,
        speed=speed,
    ):
        pcm = chunk["tts_speech"].squeeze()
        if pcm.numel() == 0:
            continue
        yield pcm.cpu(), False
```

## No Built-in Voices
CosyVoice3 has ZERO built-in speakers. Must clone a voice first using reference audio.

## Transformer Version Conflict
CosyVoice3: requires `transformers==4.51.3`
Chatterbox/Kokoro: require `transformers>=5.0`

**Solution: Separate venvs per engine**

## GitHub Issues Reference
- Issue #1446: transformers 4.53.1 causes garbled audio, 4.51.3 works
- Issue #1677: Garbled output with CosyVoice3
- Issue #1776: French TTS doesn't work (similar to our English issue)

## Benchmark (RTX 5090)
- Load: ~11s
- TTFA: 1450-2000ms
- RTF: 0.50-0.62

## Files to Create
- `src/nspeech/engines/cosyvoice.py` - adapter (NOT YET COMMITTED)
- `requirements/cosyvoice.txt` - dependency list