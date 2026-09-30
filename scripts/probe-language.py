"""Probe: language resolution in the f5tts / chatterbox adapters — offline.

Run under the engine's own venv (module imports pull torch/librosa):

    venv/f5tts/env/Scripts/python.exe scripts/probe-language.py f5tts
    venv/chatterbox/env/Scripts/python.exe scripts/probe-language.py chatterbox

Verifies the exact contract that shipped 2026-09-24: explicit language wins,
'auto'/unset detects, unknown codes raise — and the worker's flattened
top-level 'language' kwarg is honored (the old extra_body-only read ignored
every explicit language that arrived through the server).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# The engine config fails fast without the env vars the Node gateway sets per
# engine. These probes never touch the model — throwaway dirs are fine.
os.environ.setdefault("NSPEECH_ENGINE", "f5tts")
os.environ.setdefault("NSPEECH_VOICE_DIR", str(Path(__file__).parent.parent / ".probe-voices"))
os.environ.setdefault("NSPEECH_MODEL_DIR", str(Path(__file__).parent.parent / ".probe-models"))

failures = []


def check(name, actual, expected):
    if actual != expected:
        failures.append(name)
        print(f"FAIL {name}: got {actual!r}, want {expected!r}")
    else:
        print(f"ok   {name}")


def check_raises(name, fn):
    try:
        fn()
        failures.append(name)
        print(f"FAIL {name}: expected a raise, got none")
    except (ValueError, TypeError) as err:
        print(f"ok   {name} ({str(err)[:80]}...)")


def probe_f5tts():
    from nspeech.engines.f5tts import resolve_language

    GERMAN = "Der Zug fährt heute um acht Uhr über die lange Brücke."
    ENGLISH = "The train leaves today at eight over the long bridge."

    # Worker shape: language flattened to the top level (the broken path before)
    check("worker kwarg de", resolve_language({"language": "de"}, ENGLISH), "de")
    check("worker kwarg en", resolve_language({"language": "en"}, GERMAN), "en")
    # In-process shape: extra_body dict (smoke scripts call the adapter directly)
    check("extra_body dict de", resolve_language({"extra_body": {"language": "de"}}, ENGLISH), "de")
    # auto / unset / empty → detection
    check("auto detects german", resolve_language({"language": "auto"}, GERMAN), "de")
    check("auto detects english", resolve_language({"language": "auto"}, ENGLISH), "en")
    check("unset detects german", resolve_language({}, GERMAN), "de")
    check("unset detects english", resolve_language({}, ENGLISH), "en")
    check("none detects", resolve_language({"language": None}, GERMAN), "de")
    check("empty detects", resolve_language({"language": ""}, GERMAN), "de")
    # invalid → loud
    check_raises("french raises", lambda: resolve_language({"language": "fr"}, ENGLISH))
    check_raises("pt-BR raises", lambda: resolve_language({"language": "pt-BR"}, ENGLISH))
    check_raises("int raises", lambda: resolve_language({"language": 42}, ENGLISH))
    # case-insensitive
    check("DE upper", resolve_language({"language": "DE"}, ENGLISH), "de")

    print()
    if failures:
        print(f"{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("ALL F5TTS LANGUAGE PROBES PASSED")


def probe_chatterbox():
    from types import SimpleNamespace
    from nspeech.engines.chatterbox import ChatterboxAdapter, LANGUAGE_MAP

    def resolver(model_type, kwargs):
        fake = SimpleNamespace(model_type=model_type)
        return ChatterboxAdapter._resolve_language_id(fake, kwargs)

    # mtl: mapped / defaulted / invalid
    check("mtl de", resolver("mtl", {"language": "de"}), LANGUAGE_MAP["de"])
    check("mtl top-level wins", resolver("mtl", {"language": "fr", "extra_body": {"language": "ja"}}), LANGUAGE_MAP["fr"])
    check("mtl extra_body fallback", resolver("mtl", {"extra_body": {"language": "fr"}}), LANGUAGE_MAP["fr"])
    check("mtl alias german", resolver("mtl", {"language": "german"}), "de")
    check("mtl unset defaults en", resolver("mtl", {}), "en")
    check("mtl none defaults en", resolver("mtl", {"language": None}), "en")
    check("mtl empty defaults en", resolver("mtl", {"language": ""}), "en")
    check_raises("mtl unsupported raises", lambda: resolver("mtl", {"language": "xx"}))
    check_raises("mtl int raises", lambda: resolver("mtl", {"language": 7}))
    # turbo/eng: documented ignore
    check("turbo ignores language", resolver("turbo", {"language": "de"}), None)
    check("eng ignores language", resolver("eng", {"language": "xx"}), None)

    print()
    if failures:
        print(f"{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("ALL CHATTERBOX LANGUAGE PROBES PASSED")


if __name__ == "__main__":
    engine = sys.argv[1] if len(sys.argv) > 1 else ""
    if engine == "f5tts":
        probe_f5tts()
    elif engine == "chatterbox":
        probe_chatterbox()
    else:
        print("usage: probe-language.py f5tts|chatterbox   (run inside that engine's venv)")
        sys.exit(2)
