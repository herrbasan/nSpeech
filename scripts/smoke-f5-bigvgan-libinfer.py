"""Discriminate: bigvgan checkpoint quality via the library's own infer path."""
import os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
os.environ.setdefault("NSPEECH_VOICE_DIR", str(Path("venv/f5tts/voices").resolve()))
os.environ.setdefault("NSPEECH_MODEL_DIR", str(Path("venv/f5tts/models").resolve()))

from f5_tts.api import F5TTS
from nspeech.engines.f5tts import _ensure_bigvgan_config

_ensure_bigvgan_config("F5TTS_Base_bigvgan")
t0 = time.time()
m = F5TTS(
    model="F5TTS_Base_bigvgan",
    ckpt_file=str(Path("venv/f5tts/models/F5-TTS-German-bigvgan/model_615000.safetensors").resolve()),
    device="cuda",
)
print(f"loaded in {time.time()-t0:.0f}s")

wav, sr, spec = m.infer(
    ref_file="venv/f5tts/voices/Melon_DE.wav",
    ref_text="Aber der Satz setzt etwas voraus, ohne es je zu begründen, dass der Abgrund überhaupt einen Blick hat. Nietzsche hat für diese Annahme nie argumentiert, er musste es nicht.",
    gen_text=Path("logs/german-smoke.txt").read_text(encoding="utf-8").strip(),
    file_wave="logs/german-melon-de-bigvgan-libinfer.wav",
    nfe_step=32,
    speed=1.0,
    show_info=print,
)
print("done")
