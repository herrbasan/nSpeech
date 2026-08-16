"""Compare streaming-generate output against the reference model.infer path.

Renders the same text+voice+seed twice:
  1. adapter.generate()  (new parallel streaming path)
  2. model.infer()       (library batch path — current production quality)
Writes both wavs + reports RMS/peak/correlation per chunk.

Usage: python scripts/verify-f5-stream.py <text.txt> <voice> [nfe_step]
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import numpy as np
import soundfile as sf
import torch

from nspeech.engines.f5tts import F5TtsAdapter

text = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
voice = sys.argv[2] if len(sys.argv) > 2 else "Melon 3"
nfe = int(sys.argv[3]) if len(sys.argv) > 3 else 32

adapter = F5TtsAdapter()
adapter.load_voice(voice)

SEED = 42

print(f"Streaming path: {len(text)} chars, voice={voice}, nfe={nfe}, seed={SEED}")
t0 = time.time()
chunks = []
for i, (pcm, is_final) in enumerate(adapter.generate(text, voice_name=voice, nfe_step=nfe, seed=SEED)):
    dur = len(pcm) / 24000
    rms = float(torch.sqrt(torch.mean(pcm**2)))
    peak = float(pcm.abs().max())
    print(f"  chunk {i}: {dur:6.2f}s  rms={rms:.4f}  peak={peak:.4f}  final={is_final}  t={time.time()-t0:.1f}s")
    chunks.append(pcm.numpy())
stream_out = np.concatenate(chunks)
sf.write("logs/verify-stream.wav", stream_out, 24000)
print(f"  total: {len(stream_out)/24000:.2f}s in {time.time()-t0:.1f}s")

print("\nReference path (model.infer):")
t1 = time.time()
wav, sr, _ = adapter.model.infer(
    ref_file=str(adapter._voice_wav_path(voice)),
    ref_text=adapter._read_ref_text(voice),
    gen_text=text,
    nfe_step=nfe,
    seed=SEED,
)
ref_out = np.asarray(wav)
print(f"  total: {len(ref_out)/24000:.2f}s in {time.time()-t1:.1f}s")
sf.write("logs/verify-ref.wav", ref_out, 24000)

n = min(len(stream_out), len(ref_out))
if n > 0:
    corr = float(np.corrcoef(stream_out[:n], ref_out[:n])[0, 1])
    print(f"\ncomparison on first {n/24000:.1f}s: corr={corr:.3f} "
          f"(same seed, same model — expect high but not 1.0; batching differs)")
