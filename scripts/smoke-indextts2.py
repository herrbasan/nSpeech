"""Standalone IndexTTS-2 smoke test: load model, clone a voice, render text.

Usage: python scripts/smoke-indextts2.py [textfile] [voice_wav] [outfile]
"""
import sys
import time

sys.path.insert(0, "venv/indextts/repo")

from indextts.infer_v2 import IndexTTS2

text_file = sys.argv[1] if len(sys.argv) > 1 else None
voice = sys.argv[2] if len(sys.argv) > 2 else "venv/f5tts/voices/Melon 3.wav"
out_file = sys.argv[3] if len(sys.argv) > 3 else "logs/indextts2_smoke.wav"

t0 = time.time()
tts = IndexTTS2(
    cfg_path="venv/indextts/repo/checkpoints/config.yaml",
    model_dir="venv/indextts/repo/checkpoints",
    use_fp16=True,
)
print(f"model loaded in {time.time()-t0:.1f}s")

if text_file:
    from pathlib import Path
    text = Path(text_file).read_text(encoding="utf-8").strip()
else:
    text = ("The rule doesn't ask you to escape the necessary lies; "
            "it asks you to stop adding chosen ones. Not be true — reduce patterns of untruthfulness.")

t0 = time.time()
out = tts.infer(
    spk_audio_prompt=voice,
    text=text,
    output_path=out_file,
)
elapsed = time.time() - t0
print(f"rendered {len(text)} chars in {elapsed:.1f}s -> {out}")
