"""Render a VibeVoice script file to WAV. Usage: python render-vibevoice.py <script.txt> <out.wav> [voice1] [voice2]"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from nspeech.engines.vibevoice import VibevoiceAdapter

script_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
voice1 = sys.argv[3] if len(sys.argv) > 3 else "Kimi"
voice2 = sys.argv[4] if len(sys.argv) > 4 else "Deepseek"

script = script_path.read_text(encoding="utf-8").strip()
print(f"Script: {len(script)} chars, voices: {voice1} / {voice2}", flush=True)

adapter = VibevoiceAdapter()
t0 = time.time()
for pcm, is_final in adapter.generate(script, voices={"1": voice1, "2": voice2}):
    import soundfile as sf
    sf.write(str(out_path), pcm.numpy(), 24000)
    print(f"Generated: {len(pcm)} samples ({len(pcm)/24000:.1f}s) in {time.time()-t0:.0f}s", flush=True)
print("DONE", flush=True)
