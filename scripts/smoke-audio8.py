"""
Smoke test: Audio8 adapter, direct (no server).

Usage: venv/audio8/env/Scripts/python.exe scripts/smoke-audio8.py [0.1b|0.6b] [text]

Runs synthesis TWICE — first run includes model load + CUDA warmup, second
run is the warm timing. Writes out_plain.wav at 24kHz.
"""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "src"))

# Adapter reads config at import time — set the per-engine env the Node
# worker would normally inject.
os.environ.setdefault("NSPEECH_ENGINE", "audio8")
os.environ.setdefault("NSPEECH_VOICE_DIR", str(ROOT / "venv" / "audio8" / "voices"))
os.environ.setdefault("NSPEECH_MODEL_DIR", str(ROOT / "venv" / "audio8" / "models"))

args = [a for a in sys.argv[1:]]
variant = args[0] if args and args[0] in ("0.1b", "0.6b") else "0.1b"
TEXT = args[1] if len(args) > 1 else (
    "The corridor was a choice, not a necessity. "
    "A data model fixed. Each choice is a door closing."
)

from nspeech.engines.audio8 import Audio8Adapter  # noqa: E402

adapter = Audio8Adapter(engine_name="audio8-hd" if variant == "0.6b" else "audio8")
print(f"variant={variant} device={adapter.device} dtype={adapter.dtype}")

import soundfile as sf  # noqa: E402

wav = None
for run in (1, 2):
    t0 = time.time()
    for pcm, is_final in adapter.generate(TEXT, voice_name="default"):
        wav = pcm
    dur = wav.numel() / 24000
    print(f"run {run}: {time.time() - t0:.1f}s render, {dur:.1f}s audio, "
          f"{(time.time() - t0) / dur:.1f}x real-time")

sf.write("out_plain.wav", wav.numpy(), 24000)
print("wrote out_plain.wav")

voices = list(adapter.cache_dir.glob("*.audio8.txt"))
if voices:
    name = voices[0].name[: -len(".audio8.txt")]
    print(f"cloned voice found: {name}")
    t0 = time.time()
    for pcm, is_final in adapter.generate(TEXT, voice_name=name):
        wav = pcm
    print(f"cloned synthesis: {time.time() - t0:.1f}s")
    sf.write("out_cloned.wav", wav.numpy(), 24000)
    print("wrote out_cloned.wav")
else:
    print("no cloned voice found — clone one via the dashboard to test cloning")
