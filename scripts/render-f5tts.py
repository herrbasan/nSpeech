"""Render an F5-TTS text file to WAV. Usage: python render-f5tts.py <text.txt> <out.wav> [voice] [nfe_step]"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from nspeech.engines.f5tts import F5TtsAdapter

text_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
voice = sys.argv[3] if len(sys.argv) > 3 else "Melon"
nfe_step = int(sys.argv[4]) if len(sys.argv) > 4 else 32

text = text_path.read_text(encoding="utf-8").strip()
print(f"Text: {len(text)} chars, voice: {voice}, nfe_step: {nfe_step}", flush=True)

adapter = F5TtsAdapter()
adapter.load_voice(voice)
t0 = time.time()
for pcm, is_final in adapter.generate(text, voice_name=voice, nfe_step=nfe_step):
    import soundfile as sf
    sf.write(str(out_path), pcm.numpy(), 24000)
    print(f"Generated: {len(pcm)} samples ({len(pcm)/24000:.1f}s) in {time.time()-t0:.0f}s", flush=True)
print("DONE", flush=True)
