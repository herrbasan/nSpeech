"""Profile Audio8 generation — where does the wall time actually go?

Usage: venv/audio8/env/Scripts/python.exe scripts/profile-audio8.py
Short generation under torch.profiler; prints top CUDA/CPU ops + launch counts.
"""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("NSPEECH_ENGINE", "audio8")
os.environ.setdefault("NSPEECH_VOICE_DIR", str(ROOT / "venv" / "audio8" / "voices"))
os.environ.setdefault("NSPEECH_MODEL_DIR", str(ROOT / "venv" / "audio8" / "models"))

import torch  # noqa: E402
from transformers import AutoModel, AutoProcessor  # noqa: E402

TEXT = "The corridor was a choice, not a necessity."

device = "cuda"
processor = AutoProcessor.from_pretrained("Audio8/Audio8-TTS-Preview-0.1b", trust_remote_code=True)
model = AutoModel.from_pretrained(
    "Audio8/Audio8-TTS-Preview-0.1b", trust_remote_code=True, dtype=torch.bfloat16
).eval().to(device)

inputs = processor(text=[TEXT], return_tensors="pt")
inputs = {k: v.to(device) for k, v in inputs.items()}

# Warmup (kernel compile, cudnn autotune)
with torch.inference_mode():
    model.generate(**inputs, max_new_tokens=128, temperature=0.8, top_p=0.95,
                   top_k=50, do_sample=True, return_dict_in_generate=True)

from torch.profiler import profile, ProfilerActivity  # noqa: E402

with torch.inference_mode():
    with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as prof:
        t0 = time.time()
        model.generate(**inputs, max_new_tokens=256, temperature=0.8, top_p=0.95,
                       top_k=50, do_sample=True, return_dict_in_generate=True)
        wall = time.time() - t0

print(f"\nwall: {wall:.1f}s for 256 tokens ({256 / wall:.0f} tok/s)\n")
print("=== top 25 by CUDA time ===")
print(prof.key_averages().table(sort_by="cuda_time_total", row_limit=25))
print("=== top 15 by CPU time ===")
print(prof.key_averages().table(sort_by="cpu_time_total", row_limit=15))
