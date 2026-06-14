#!/usr/bin/env python3
"""
nSpeech Service Installer
=========================
Installs the text-to-speech service with per-engine isolation.
Supports: kokoro, cosyvoice, chatterbox, or all engines.

Layout:
    venv/
      kokoro/
        env/          # Python virtual environment
        models/       # ONNX weights, voice bins
      cosyvoice/
        env/
        models/       # CosyVoice repo clone, weights
      chatterbox/
        env/
        models/

Usage:
    python install.py install --engine kokoro
    python install.py install --engine cosyvoice --models
    python install.py install --engine all
    python install.py update --engine kokoro
    python install.py verify --engine kokoro
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import venv
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.resolve()
REQUIREMENTS_DIR = PROJECT_ROOT / "requirements"
VENV_BASE = PROJECT_ROOT / "venv"

ENGINES = ["kokoro", "cosyvoice", "chatterbox", "dots", "all"]

# Per-engine Python version override.
# Engines not listed here use the system Python (whatever runs install.py).
# dots.tts requires 3.10-3.12 (does NOT support 3.13).
ENGINE_PYTHON_VERSIONS = {
    "dots": "3.10",
}

ENGINE_PATCHES = {
    "chatterbox": ["patch_chatterbox"],
    "cosyvoice": [],
    "kokoro": [],
    "dots": [],
}


def _env_dir(engine):
    return VENV_BASE / engine / "env"


def _models_dir(engine):
    return VENV_BASE / engine / "models"


def _voices_dir(engine):
    return VENV_BASE / engine / "voices"


def _python(engine):
    d = _env_dir(engine)
    if platform.system() == "Windows":
        return d / "Scripts" / "python.exe"
    return d / "bin" / "python"


def _pip(engine):
    d = _env_dir(engine)
    if platform.system() == "Windows":
        return d / "Scripts" / "pip.exe"
    return d / "bin" / "pip"


def _resolve_engine_python(engine):
    """
    Find the Python executable for an engine's venv.

    Engines listed in ENGINE_PYTHON_VERSIONS get a venv created with that
    specific Python version (found via the Windows py launcher or PATH).
    Engines not listed return None — the system Python is used.

    This is the whole point of per-engine venvs: each engine gets the runtime
    it actually needs, not whatever the OS happens to default to.
    """
    version = ENGINE_PYTHON_VERSIONS.get(engine)
    if not version:
        return None

    if platform.system() == "Windows":
        # Use the py launcher to find the exact version
        result = run(["py", f"-{version}", "-c", "import sys; print(sys.executable)"],
                     capture=True, check=False)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        raise RuntimeError(
            f"Python {version} not found via 'py -{version}'. "
            f"Install it or add it to PATH."
        )
    else:
        # On Unix, try python3.X directly
        candidate = f"python{version}"
        result = run(["which", candidate], capture=True, check=False)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        raise RuntimeError(
            f"Python {version} not found. Install {candidate} or add it to PATH."
        )


# ── Helpers ──────────────────────────────────────────────────────────────────


def run(cmd, cwd=None, check=True, capture=False):
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    kwargs = {"cwd": cwd, "check": check}
    if capture:
        kwargs["capture_output"] = True
        kwargs["text"] = True
    return subprocess.run(cmd, **kwargs)


def create_env_file():
    env_path = PROJECT_ROOT / ".env"
    example_path = PROJECT_ROOT / ".env.example"
    if not env_path.exists() and example_path.exists():
        print("[*] Creating default .env file from .env.example ...")
        shutil.copy(example_path, env_path)


def load_env():
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()


# ── Venv Management ──────────────────────────────────────────────────────────


def create_venv(engine):
    env_path = _env_dir(engine)

    if env_path.exists():
        print(f"[!] venv already exists at {env_path}")
        response = input("    Delete and recreate? [y/N]: ").strip().lower()
        if response == "y":
            shutil.rmtree(env_path)
            print("    Deleted existing env.")
        else:
            print("    Keeping existing env.")
            return False

    VENV_BASE.mkdir(parents=True, exist_ok=True)
    (VENV_BASE / engine).mkdir(parents=True, exist_ok=True)

    # Resolve which Python to use for this engine's venv.
    # Most engines use the system Python. Some (dots.tts) need a specific version.
    target_python = _resolve_engine_python(engine)

    print(f"[*] Creating venv at {env_path} ...")
    if target_python:
        print(f"    Using Python: {target_python}")
        run([target_python, "-m", "venv", "--copies", str(env_path)])
    else:
        print(f"    Using system Python: {sys.executable}")
        venv.create(env_path, with_pip=True)
    print(f"[+] venv created: venv/{engine}/env/")
    return True


def ensure_models_dir(engine):
    d = _models_dir(engine)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Install Steps ────────────────────────────────────────────────────────────


def install_core(python):
    print("[*] Installing core requirements ...")
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])

    core_req = REQUIREMENTS_DIR / "core.txt"
    if core_req.exists():
        run([str(python), "-m", "pip", "install", "-r", str(core_req)])

    print("[+] Core requirements installed.")


def install_engine_deps(python, engine):
    print(f"[*] Installing {engine} requirements ...")

    engine_req = REQUIREMENTS_DIR / f"{engine}.txt"
    if engine_req.exists():
        run([str(python), "-m", "pip", "install", "-r", str(engine_req)])
    else:
        print(f"    [!] No requirements file found: {engine_req}")

    if engine == "kokoro":
        print("[*] Installing PyTorch CPU for Kokoro ...")
        run([str(python), "-m", "pip", "install", "torch", "torchaudio",
             "--index-url", "https://download.pytorch.org/whl/cpu"])

    elif engine == "cosyvoice":
        print("[*] Installing PyTorch with CUDA for CosyVoice ...")
        run([str(python), "-m", "pip", "uninstall", "-y", "torch", "torchaudio"])
        run([str(python), "-m", "pip", "install", "torch", "torchaudio",
             "--index-url", "https://download.pytorch.org/whl/cu126"])
        run([str(python), "-m", "pip", "install", "onnxruntime-gpu>=1.21.0"])

        print("[*] Installing CosyVoice pinned dependencies ...")
        run([str(python), "-m", "pip", "install",
             "transformers==4.51.3", "tokenizers==0.21.0", "huggingface-hub==0.30.0"])

    elif engine == "chatterbox":
        run([str(python), "-m", "pip", "uninstall", "-y", "torch", "torchaudio"])
        run([str(python), "-m", "pip", "install", "torch", "torchaudio",
             "--index-url", "https://download.pytorch.org/whl/nightly/cu128"])

    print("[+] Engine requirements installed.")


def patch_chatterbox(python):
    patches_applied = 0

    result = run(
        [str(python), "-c", "import perth; print(perth.__file__)"],
        capture=True, check=False
    )
    if result.returncode != 0:
        print("[!] perth not installed yet, skipping patches.")
        return 0

    perth_init = Path(result.stdout.strip()).resolve()
    perth_dir = perth_init.parent

    content = perth_init.read_text(encoding="utf-8")
    if "from .perth_net" in content:
        lines_to_keep = []
        skip = False
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("try:"):
                continue
            if "from .perth_net" in stripped:
                lines_to_keep.append("PerthImplicitWatermarker = DummyWatermarker")
                skip = True
                continue
            if skip and stripped in ("except ImportError:", "except Exception:"):
                continue
            if skip and stripped.startswith("PerthImplicitWatermarker = None"):
                skip = False
                continue
            if skip and stripped == "":
                skip = False
                lines_to_keep.append(line)
                continue
            if skip:
                continue
            if stripped.startswith("if PerthImplicitWatermarker") or stripped.startswith("if __all__"):
                continue
            lines_to_keep.append(line)
        content = "\n".join(lines_to_keep) + "\n"
        perth_init.write_text(content, encoding="utf-8")
        patches_applied += 1
        print("    [+] Patched perth __init__ (disabled PerthImplicitWatermarker)")

    perth_net_init = perth_dir / "perth_net" / "__init__.py"
    if perth_net_init.exists():
        net_content = perth_net_init.read_text(encoding="utf-8")
        if "from .perth_net_implicit" in net_content:
            net_content = net_content.replace(
                "from .perth_net_implicit.perth_watermarker import PerthImplicitWatermarker",
                "# PerthImplicitWatermarker import disabled (deadlocks on Windows/Python 3.13)"
            )
            perth_net_init.write_text(net_content, encoding="utf-8")
            patches_applied += 1
            print("    [+] Patched perth_net __init__ (disabled implicit import)")

    result = run(
        [str(python), "-c", "import chatterbox; print(chatterbox.__file__)"],
        capture=True, check=False
    )
    if result.returncode != 0:
        print("[!] chatterbox not installed yet, skipping patches.")
        return patches_applied

    tts_path = Path(result.stdout.strip())
    tts_py = tts_path.parent / "tts.py"

    if not tts_py.exists():
        return patches_applied

    content = tts_py.read_text(encoding="utf-8")
    if "perth.PerthImplicitWatermarker()" in content:
        content = content.replace(
            "self.watermarker = perth.PerthImplicitWatermarker()",
            "self.watermarker = perth.DummyWatermarker()"
        )
        patches_applied += 1
        print("    [+] Patched chatterbox watermarker -> DummyWatermarker")

    tts_py.write_text(content, encoding="utf-8")
    print(f"[+] {patches_applied} patch(es) applied.")
    return patches_applied


def _install_cosyvoice_models(python, model_dir):
    repo_dir = model_dir / "CosyVoice"
    repo_url = "https://github.com/FunAudioLLM/CosyVoice.git"

    if not repo_dir.exists():
        print(f"    [*] Cloning CosyVoice repo (with submodules) ...")
        print(f"        This may take a few minutes (~500 MB).")
        run(["git", "clone", "--recursive", repo_url, str(repo_dir)])
        print(f"    [+] Repo cloned to {repo_dir}")
    else:
        print(f"    [+] CosyVoice repo already exists at {repo_dir}")
        print(f"    [*] Updating submodules ...")
        run(["git", "-C", str(repo_dir), "submodule", "update", "--init", "--recursive"])
        print(f"    [+] Submodules updated.")

    pretrained_dir = model_dir / "pretrained_models"
    model_dest = pretrained_dir / "Fun-CosyVoice3-0.5B"
    if model_dest.exists() and (model_dest / "cosyvoice3.yaml").exists():
        print(f"    [+] CosyVoice3 model already downloaded at {model_dest}")
        return

    print(f"    [*] Downloading CosyVoice3-0.5B from HuggingFace ...")
    print(f"        This may take a while (~2 GB).")
    run([
        str(python), "-c",
        f"from huggingface_hub import snapshot_download; "
        f"snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', "
        f"local_dir=r'{model_dest}')"
    ])
    print(f"    [+] Model downloaded to {model_dest}")


def download_models(python, engine):
    print(f"[*] Downloading {engine} models ...")
    model_dir = ensure_models_dir(engine)

    if engine == "chatterbox":
        print("    Downloading Chatterbox weights ...")
        run([
            str(python), "-c",
            f"import sys; sys.path.insert(0, 'src'); "
            f"import os; os.environ['NSPEECH_MODEL_DIR'] = r'{model_dir}'; "
            f"from chatterbox.tts import ChatterboxTTS; "
            f"ChatterboxTTS.from_pretrained(device='cpu')"
        ], cwd=str(PROJECT_ROOT))

    elif engine == "kokoro":
        urls = [
            ("https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
             model_dir / "kokoro-v1.0.onnx"),
            ("https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
             model_dir / "voices-v1.0.bin")
        ]

        import urllib.request
        for url, dest in urls:
            if dest.exists() and dest.stat().st_size > 0:
                print(f"    [+] {dest.name} already exists.")
                continue

            print(f"    [*] Downloading {dest.name} ...")
            try:
                with urllib.request.urlopen(url) as response, open(dest, 'wb') as out_file:
                    shutil.copyfileobj(response, out_file)
                print(f"    [+] Downloaded {dest.name}")
            except Exception as e:
                print(f"    [-] Failed to download {dest.name}: {e}")
                if dest.exists():
                    dest.unlink()
                sys.exit(1)

    elif engine == "cosyvoice":
        _install_cosyvoice_models(python, model_dir)

    print("[+] Models ready.")


def verify_engine(python, engine):
    print(f"[*] Verifying {engine} installation ...")

    checks = []
    if engine == "chatterbox":
        checks.append(("PyTorch", "import torch; print(f'PyTorch {torch.__version__}')"))
        checks.append(("Chatterbox", "import chatterbox; print('chatterbox OK')"))
    elif engine == "kokoro":
        checks.append(("PyTorch", "import torch; print(f'PyTorch {torch.__version__}')"))
        checks.append(("Kokoro ONNX", "import kokoro_onnx; print('kokoro OK')"))
    elif engine == "cosyvoice":
        checks.append(("PyTorch", "import torch; print(f'PyTorch {torch.__version__}')"))
        checks.append(("Transformers", "import transformers; print(f'transformers {transformers.__version__}')"))
        checks.append(("pyworld", "import pyworld; print('pyworld OK')"))
        repo_dir = _models_dir(engine) / "CosyVoice"
        if repo_dir.exists():
            print(f"    [+] CosyVoice repo found at {repo_dir}")
        else:
            print(f"    [-] CosyVoice repo NOT found at {repo_dir}")
            all_ok = False

    checks.append(("soundfile", "import soundfile; print('soundfile OK')"))

    all_ok = True
    for name, code in checks:
        result = run([str(python), "-c", code], capture=True, check=False)
        if result.returncode == 0:
            print(f"    [+] {name}: {result.stdout.strip()}")
        else:
            print(f"    [-] {name}: FAILED")
            all_ok = False

    return all_ok


# ── Full Install Pipeline ────────────────────────────────────────────────────


def install_engine_full(engine, args):
    create_venv(engine)
    _voices_dir(engine).mkdir(parents=True, exist_ok=True)
    python = _python(engine)

    if not python.exists():
        print(f"[-] Python not found at {python}")
        return False

    install_core(python)
    install_engine_deps(python, engine)

    for patch_func in ENGINE_PATCHES.get(engine, []):
        if patch_func == "patch_chatterbox":
            patch_chatterbox(python)

    if args.models or engine == "kokoro":
        download_models(python, engine)

    all_ok = verify_engine(python, engine)
    print(f"[+] {engine} installation {'PASSED' if all_ok else 'FAILED'}")
    return all_ok


# ── Commands ─────────────────────────────────────────────────────────────────


def cmd_install(args):
    print("=" * 60)
    print("nSpeech Service Installer")
    print("=" * 60)
    print()

    create_env_file()
    load_env()

    engine = args.engine
    print(f"[*] Engine: {engine}")
    print()

    if engine == "all":
        engines_to_install = ["kokoro", "cosyvoice", "chatterbox"]
    else:
        engines_to_install = [engine]

    results = {}
    for eng in engines_to_install:
        print()
        print("=" * 40)
        print(f"Installing: {eng}")
        print("=" * 40)
        try:
            results[eng] = install_engine_full(eng, args)
        except Exception as e:
            print(f"[-] {eng} installation failed: {e}")
            results[eng] = False

    print()
    print("=" * 60)
    print("Installation Summary")
    print("=" * 60)
    for eng, success in results.items():
        status = "PASSED" if success else "FAILED"
        print(f"  {eng:12} venv/{eng}/env/  [{status}]")

    print()
    print("To start an engine:")
    for eng in engines_to_install:
        if results.get(eng, False):
            print(f"  venv\\{eng}\\env\\Scripts\\python run.py")

    print()
    print("Make sure .env points to the correct engine directories:")
    print("  NSPEECH_ENGINE=<engine>")
    print("  NSPEECH_MODEL_DIR=venv/<engine>/models")
    print("  NSPEECH_VOICE_DIR=venv/<engine>/voices")

    if all(results.values()):
        print()
        print("Installation complete!")
    else:
        print()
        print("Some installations failed. Check errors above.")
        sys.exit(1)


def cmd_update(args):
    engine = args.engine
    env_path = _env_dir(engine)

    if not env_path.exists():
        print(f"[!] No installation found for {engine}. Run 'install --engine {engine}' first.")
        sys.exit(1)

    python = _python(engine)

    print(f"[*] Updating {engine} ...")
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])

    core_req = REQUIREMENTS_DIR / "core.txt"
    if core_req.exists():
        run([str(python), "-m", "pip", "install", "--upgrade", "-r", str(core_req)])

    engine_req = REQUIREMENTS_DIR / f"{engine}.txt"
    if engine_req.exists():
        run([str(python), "-m", "pip", "install", "--upgrade", "-r", str(engine_req)])

    for patch_func in ENGINE_PATCHES.get(engine, []):
        if patch_func == "patch_chatterbox":
            patch_chatterbox(python)

    verify_engine(python, engine)
    print("[+] Update complete.")


def cmd_verify(args):
    engine = args.engine
    env_path = _env_dir(engine)

    if not env_path.exists():
        print(f"[!] No installation found for {engine}. Run 'install --engine {engine}' first.")
        sys.exit(1)

    python = _python(engine)
    all_ok = verify_engine(python, engine)

    if all_ok:
        print(f"[+] {engine} verification PASSED")
    else:
        print(f"[-] {engine} verification FAILED")
        sys.exit(1)


def cmd_models(args):
    engine = args.engine
    env_path = _env_dir(engine)

    if not env_path.exists():
        print(f"[!] No installation found for {engine}. Run 'install --engine {engine}' first.")
        sys.exit(1)

    python = _python(engine)
    download_models(python, engine)


# ── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Install/update nSpeech TTS service")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_install = subparsers.add_parser("install", help="Fresh install")
    p_install.add_argument("--engine", "-e", required=True,
                           choices=ENGINES, help="Engine to install")
    p_install.add_argument("--models", action="store_true", help="Pre-download model weights")

    p_update = subparsers.add_parser("update", help="Update packages")
    p_update.add_argument("--engine", "-e", required=True,
                          choices=["kokoro", "cosyvoice", "chatterbox"],
                          help="Engine to update")

    p_verify = subparsers.add_parser("verify", help="Verify installation")
    p_verify.add_argument("--engine", "-e", required=True,
                         choices=["kokoro", "cosyvoice", "chatterbox"],
                         help="Engine to verify")

    p_models = subparsers.add_parser("models", help="Download model weights")
    p_models.add_argument("--engine", "-e", required=True,
                          choices=["kokoro", "cosyvoice", "chatterbox"],
                          help="Engine to download models for")

    args = parser.parse_args()

    commands = {
        "install": cmd_install,
        "update": cmd_update,
        "verify": cmd_verify,
        "models": cmd_models,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
