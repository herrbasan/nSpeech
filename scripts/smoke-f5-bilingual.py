"""Bilingual F5 smoke: one adapter, DE then EN request, verifies per-request routing."""
import os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

os.environ.setdefault("NSPEECH_ENGINE", "f5tts")
os.environ.setdefault("NSPEECH_VOICE_DIR", str(Path("venv/f5tts/voices").resolve()))
os.environ.setdefault("NSPEECH_MODEL_DIR", str(Path("venv/f5tts/models").resolve()))
os.environ.setdefault("NSPEECH_F5_CKPT_DE", str(Path("venv/f5tts/models/F5-TTS-German/model_420000.safetensors").resolve()))

from nspeech.engines.f5tts import F5TtsAdapter, detect_language

ad = F5TtsAdapter()

def render(text, out, voice, extra=None):
    lang = (extra or {}).get("language") or detect_language(text)
    t0 = time.time()
    total = 0
    for chunk, final in ad.generate(text, voice_name=voice, nfe_step=32, extra_body=extra or {}):
        total += chunk.shape[-1] / 24000
    print(f"[{lang}] {out}: {total:.1f}s audio in {time.time()-t0:.1f}s wall", flush=True)

render("Der Regen prasselt gegen die Fensterscheiben, während drinnen die Lampe ein warmes Licht wirft.",
       "logs/bilingual-de.wav", "Melon_DE")
render("The rain patters against the window panes while inside the lamp casts a warm light.",
       "logs/bilingual-en.wav", "Simon")

import torch
print(f"models resident: {list(ad._models.keys())}, VRAM: {torch.cuda.memory_allocated()/2**30:.1f}GB")
