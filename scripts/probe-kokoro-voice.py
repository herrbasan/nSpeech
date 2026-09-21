"""
Probe: Kokoro voice resolution — the `default` sentinel and unknown voices.

Issue #2 — the Kokoro worker crashed with an unhandled ASGI exception on
voice:'default', and any unresolvable voice ended in a bare 500 instead of a
typed 404. Both behaviours live in KokoroAdapter.generate():

  A. voice_name='default'  → resolves to the engine's own default voice
  B. unknown voice         → raises FileNotFoundError, the error type every
                             other adapter raises and worker_routes maps to
                             404 voice_not_found
  C. a real built-in voice still works

No model load: the ONNX pipeline is replaced with a fake that records lookups.

Run: venv/kokoro/env/Scripts/python.exe scripts/probe-kokoro-voice.py
"""
import os
import sys
import threading
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

# nspeech.config validates these at import.
_tmp = tempfile.mkdtemp(prefix="nspeech-probe-")
os.environ.setdefault("NSPEECH_ENGINE", "kokoro")
os.environ.setdefault("NSPEECH_VOICE_DIR", _tmp)
os.environ.setdefault("NSPEECH_MODEL_DIR", _tmp)

import numpy as np
from nspeech.engines.kokoro import KokoroAdapter

BUILTINS = ["af_heart", "af_bella", "am_fenrir", "bf_emma"]


class FakePipeline:
    """Records style lookups; raises KeyError for anything not in the catalog,
    which is what kokoro_onnx does for an unknown voice."""

    def __init__(self):
        self.style_lookups = []

    def get_voices(self):
        return list(BUILTINS)

    def get_voice_style(self, name):
        if name not in BUILTINS:
            raise KeyError(f"Voice {name!r} not found")
        self.style_lookups.append(name)
        return np.zeros(8, dtype=np.float32)

    def create(self, text, voice=None, speed=1.0):
        return np.zeros(240, dtype=np.float32), 24000


def make_adapter():
    a = object.__new__(KokoroAdapter)  # skip __init__ — no model load
    a.pipeline = FakePipeline()
    a.active_voices = {}
    a.current_voice = None
    a.cache_dir = Path(_tmp)
    a._voice_lock = threading.Lock()
    a.engine_name = "kokoro"
    return a


failures = 0


def report(label, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}{' — ' + detail if detail else ''}")


# ── A. the 'default' sentinel ─────────────────────────────────────────────
a = make_adapter()
try:
    audio = list(a.generate("Hello there.", voice_name="default"))
    frames = sum(t.numel() for t, _ in audio)
    report("A. voice_name='default' does not raise", True)
    report("A. resolves to the engine's default voice",
           a.pipeline.style_lookups == [KokoroAdapter.DEFAULT_VOICE],
           f"lookups={a.pipeline.style_lookups} want=[{KokoroAdapter.DEFAULT_VOICE}]")
    report("A. produced audio", frames > 0, f"{frames} samples")
except Exception as e:  # noqa: BLE001 — the probe reports, it doesn't handle
    report("A. voice_name='default' does not raise", False, f"{type(e).__name__}: {e}")

# ── B. unknown voice fails fast ───────────────────────────────────────────
a = make_adapter()
try:
    list(a.generate("Hello there.", voice_name="en-US-Male"))
    report("B. unknown voice raises FileNotFoundError", False, "no exception raised")
except FileNotFoundError as e:
    report("B. unknown voice raises FileNotFoundError", True, str(e))
except Exception as e:  # noqa: BLE001
    report("B. unknown voice raises FileNotFoundError", False,
           f"wrong type: {type(e).__name__}: {e}")
report("B. unknown voice not fabricated into active_voices",
       "en-US-Male" not in a.active_voices, f"active_voices={list(a.active_voices)}")

# ── C. a real built-in still works ────────────────────────────────────────
a = make_adapter()
try:
    list(a.generate("Hello there.", voice_name="af_bella"))
    report("C. built-in voice still works",
           a.pipeline.style_lookups == ["af_bella"], f"lookups={a.pipeline.style_lookups}")
except Exception as e:  # noqa: BLE001
    report("C. built-in voice still works", False, f"{type(e).__name__}: {e}")

print()
print("ALL PASS" if failures == 0 else f"{failures} CHECK(S) FAILED")
sys.exit(1 if failures else 0)
