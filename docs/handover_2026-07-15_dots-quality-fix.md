# Dots.tts Quality Fix Attempt — 2026-07-15

## Problem
User reported that dots.tts quality varies greatly depending on the sentence. Sometimes excellent, sometimes poor. Also noticed the start of the first sentence sounds slightly cut off.

## What I Tried

### 1. Parameter Name Mismatch Fix
**Issue:** Dashboard sends `inference_steps` but adapter reads `steps` or `num_steps`. The steps slider was silently ignored, always using default 4.

**Fix:** Changed line 202 in `src/nspeech/engines/dots.py`:
```python
# Before:
num_steps = kwargs.get("steps", kwargs.get("num_steps", 4))

# After:
num_steps = kwargs.get("inference_steps", kwargs.get("steps", kwargs.get("num_steps", 4)))
```

**Status:** ✅ Fixed and verified

### 2. First Chunk Transient Fix
**Issue:** The resampler processes each chunk independently with no history. First chunk has no context, causing a FIR filter transient that cuts off the start.

**Fix Attempt:** Added padding before resampling the first chunk:
```python
if first_chunk:
    pad_samples = 200  # ~4ms at 48kHz
    pcm_padded = torch.cat([torch.zeros(pad_samples, dtype=pcm.dtype), pcm])
    pcm_resampled = self._resampler(pcm_padded.unsqueeze(0)).squeeze(0)
    trim_samples = int(pad_samples * 24000 / self.native_sample_rate)
    pcm = pcm_resampled[trim_samples:]
    first_chunk = False
```

**Status:** ❌ Failed — caused dimension mismatch error

### 3. Checkpoint Switch to `soar`
**Issue:** User wanted better quality, willing to trade speed.

**Fix:** Changed default checkpoint from `mf` (4 NFE) to `soar` (10-32 NFE):
- Updated `.env` to add `NSPEECH_DOTS_CHECKPOINT=soar`
- Updated adapter default in `src/nspeech/engines/dots.py` line 66

**Status:** ❌ Failed — caused 500 errors due to tensor dimension mismatch

## Where It Failed

### Error 1: Tensor Dimension Mismatch
After switching to `soar` checkpoint and adding the padding fix, got:
```
RuntimeError: Tensors must have same number of dimensions: got 1 and 2
```
at line 269 in `dots.py`: `torch.cat([torch.zeros(pad_samples, dtype=pcm.dtype), pcm])`

**Root Cause:** The `soar` checkpoint returns tensors with shape `(1, 1, samples)` instead of `(1, samples)`. The `squeeze(0)` wasn't reducing it to 1D, so `pcm` was still 2D when trying to concatenate with the 1D zeros tensor.

**Attempted Fix:** Changed `squeeze(0)` to `flatten()` to ensure 1D:
```python
pcm = chunk.detach().float().cpu()
pcm = pcm.flatten()  # Instead of squeeze(0)
```

**Result:** Still failed, went in circles trying to debug.

## Current State
- All changes rolled back using `git restore src/nspeech/engines/dots.py`
- `.env` reverted (no `NSPEECH_DOTS_CHECKPOINT` line)
- Back to original `mf` checkpoint with original code
- Server needs restart to pick up the rollback

## What We Know
1. The `inference_steps` parameter name mismatch is real and should be fixed
2. The `soar` checkpoint has different tensor shapes than `mf` — needs investigation
3. The first-chunk transient fix needs proper dimension handling
4. Quality variation is likely intrinsic to the `mf` checkpoint (4 NFE, MeanFlow distilled)

## Next Steps
- Fix the `inference_steps` parameter name mismatch (simple, safe)
- If switching to `soar`, need to handle tensor dimensions properly (use `flatten()` instead of `squeeze(0)`)
- For the first-chunk transient, need to ensure `pcm` is 1D before padding
- Consider testing `soar` checkpoint quality vs speed tradeoff separately
