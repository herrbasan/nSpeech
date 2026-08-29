"""Probe: does torch.compile speed up Audio8 generation on Windows?

Usage: venv/audio8/env/Scripts/python.exe scripts/probe-audio8-compile.py [reduce-overhead|default|none]
Renders the same text twice (warm), reports wall time + real-time factor.
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

MODE = sys.argv[1] if len(sys.argv) > 1 else "reduce-overhead"
TEXT = (
    "The corridor was a choice, not a necessity. "
    "A data model fixed. Each choice is a door closing."
)

import torch  # noqa: E402
from transformers import AutoModel, AutoProcessor  # noqa: E402

device = "cuda"
processor = AutoProcessor.from_pretrained("Audio8/Audio8-TTS-Preview-0.1b", trust_remote_code=True)
model = AutoModel.from_pretrained(
    "Audio8/Audio8-TTS-Preview-0.1b", trust_remote_code=True, dtype=torch.bfloat16
).eval().to(device)

if MODE != "none":
    print(f"compiling ({MODE}) ... first call includes compile time")
    model = torch.compile(model, mode=MODE if MODE != "default" else None)

def render():
    inputs = processor(text=[TEXT], return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    t0 = time.time()
    with torch.inference_mode():
        out = model.generate(
            **inputs, max_new_tokens=1024, temperature=0.8, top_p=0.95,
            top_k=50, do_sample=True, return_dict_in_generate=True,
        )
        waveforms, lengths = model.decode_audio(out.codes)
    dur = int(lengths[0]) / 44100
    elapsed = time.time() - t0
    print(f"  render {elapsed:.1f}s -> {dur:.1f}s audio ({elapsed / dur:.1f}x real-time)")

for run in (1, 2, 3):
    print(f"run {run}:")
    render()
