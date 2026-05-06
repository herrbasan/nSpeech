#!/usr/bin/env python3
"""
nSpeech Service Installer
=========================
Installs the text-to-speech service (Chatterbox TTS) into a
self-contained virtual environment. Supports install, update, and verify.

Usage:
    python install.py install     # Fresh install
    python install.py update      # Update packages
    python install.py verify      # Check installation health
    python install.py models      # Pre-download model weights

The installer handles:
- Creating a Python venv
- Installing PyTorch with CUDA support
- Installing chatterbox-tts
- Patching known compatibility issues
- Pre-downloading model weights (optional)
"""
import argparse
import os
import platform
import shutil
import subprocess
import sys
import venv
from pathlib import Path

# Need to insert src into sys.path for config import
sys.path.insert(0, str(Path(__file__).parent.resolve() / "src"))

# ── Configuration ────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).parent.resolve()
VENV_DIR = PROJECT_ROOT / "venv"
REQUIREMENTS_DIR = PROJECT_ROOT / "requirements"

# PyTorch index URL for CUDA wheels
# Adjust this for your CUDA version / GPU architecture
TORCH_INDEX_URL = "https://download.pytorch.org/whl/cu128"

# Models to pre-download (HuggingFace repo IDs)
CHATTERBOX_REPO = "ResembleAI/chatterbox"

# ── Helpers ──────────────────────────────────────────────────────────────────


def run(cmd, cwd=None, check=True, capture=False):
    """Run a shell command, streaming output by default."""
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    kwargs = {"cwd": cwd, "check": check}
    if capture:
        kwargs["capture_output"] = True
        kwargs["text"] = True
    return subprocess.run(cmd, **kwargs)


def create_env_file():
    """Create a default .env file if it doesn't exist."""
    env_path = PROJECT_ROOT / ".env"
    example_path = PROJECT_ROOT / ".env.example"
    if not env_path.exists() and example_path.exists():
        print("[*] Creating default .env file from .env.example ...")
        shutil.copy(example_path, env_path)


def get_python():
    """Return the path to the venv Python executable."""
    if platform.system() == "Windows":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def get_pip():
    """Return the path to the venv pip executable."""
    if platform.system() == "Windows":
        return VENV_DIR / "Scripts" / "pip.exe"
    return VENV_DIR / "bin" / "pip"


def in_venv():
    """Check if we're already inside the target venv."""
    return sys.prefix == str(VENV_DIR)


def create_venv():
    """Create the virtual environment."""
    if VENV_DIR.exists():
        print(f"[!] venv already exists at {VENV_DIR}")
        response = input("    Delete and recreate? [y/N]: ").strip().lower()
        if response == "y":
            shutil.rmtree(VENV_DIR)
            print("    Deleted existing venv.")
        else:
            print("    Keeping existing venv.")
            return

    print(f"[*] Creating venv at {VENV_DIR} ...")
    venv.create(VENV_DIR, with_pip=True)
    print("[+] venv created.")


def install_pytorch(python):
    """Install PyTorch with CUDA support."""
    print(f"[*] Installing PyTorch (CUDA) from {TORCH_INDEX_URL} ...")
    run([
        str(python), "-m", "pip", "install", "--upgrade", "pip"
    ])
    run([
        str(python), "-m", "pip", "install",
        "torch==2.8.0", "torchaudio==2.8.0",
        "--index-url", TORCH_INDEX_URL,
    ])
    print("[+] PyTorch installed.")


def install_requirements(python, engine=None):
    """Install core and engine-specific packages."""
    print("[*] Installing core requirements ...")
    core_req = REQUIREMENTS_DIR / "core.txt"
    if core_req.exists():
        run([str(python), "-m", "pip", "install", "-r", str(core_req)])

    if engine:
        print(f"[*] Installing {engine} requirements ...")
        engine_req = REQUIREMENTS_DIR / f"{engine}.txt"
        if engine_req.exists():
            run([str(python), "-m", "pip", "install", "-r", str(engine_req)])
        else:
            print(f"    [!] No specific requirements file found for engine: {engine}")
    
    print("[+] Requirements installed.")


def patch_chatterbox(python):
    """Apply known compatibility patches to chatterbox-tts and resemble-perth."""
    patches_applied = 0

    # ── Patch perth: disable broken PerthImplicitWatermarker import ──
    result = run(
        [str(python), "-c", "import perth; print(perth.__file__)"],
        capture=True, check=False
    )
    if result.returncode == 0:
        perth_init = Path(result.stdout.strip()).resolve()
        perth_dir = perth_init.parent

        content = perth_init.read_text(encoding="utf-8")
        if "from .perth_net" in content:
            lines_to_keep = []
            skip = False
            for line in content.splitlines():
                stripped = line.strip()
                if stripped.startswith("try:") and "perth_net" not in stripped:
                    lines_to_keep.append(line)
                    continue
                if "from .perth_net" in stripped:
                    lines_to_keep.append("PerthImplicitWatermarker = None")
                    skip = True
                    continue
                if skip and stripped in ("except ImportError:", "except Exception:"):
                    skip = True
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
    else:
        print("[!] perth not installed yet, skipping patches.")

    # ── Patch chatterbox: use DummyWatermarker instead ──
    result = run(
        [str(python), "-c", "import chatterbox; print(chatterbox.__file__)"],
        capture=True, check=False
    )
    if result.returncode != 0:
        print("[!] chatterbox not installed yet, skipping patches.")
        print(f"[+] {patches_applied} patch(es) applied.")
        return

    tts_path = Path(result.stdout.strip())
    tts_py = tts_path.parent / "tts.py"

    if not tts_py.exists():
        print(f"[!] Could not find {tts_py}")
        print(f"[+] {patches_applied} patch(es) applied.")
        return

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


def download_models(python):
    """Pre-download model weights so first run is fast."""
    print("[*] Pre-downloading model weights ...")

    # We import config to ensure HF_HOME is set before chatterbox loads
    print("    Downloading Chatterbox weights ...")
    
    # Must add src to sys.path to import nspeech without installing it
    run([
        str(python), "-c",
        f"import sys; sys.path.insert(0, 'src'); "
        f"import nspeech.config; "
        f"from chatterbox.tts import ChatterboxTTS; "
        f"ChatterboxTTS.from_pretrained(device='cpu')"
    ], cwd=str(PROJECT_ROOT))
    
    print("[+] Models downloaded.")


def verify_installation(python):
    """Verify that everything works."""
    print("[*] Verifying installation ...")

    checks = [
        ("PyTorch + CUDA", "import torch; assert torch.cuda.is_available(), 'CUDA not available'; print(f'PyTorch {torch.__version__}, CUDA OK')"),
        ("Kokoro ONNX", "import kokoro_onnx; print('kokoro OK')"),
        ("Chatterbox", "import chatterbox; print('chatterbox OK')"),
        ("soundfile", "import soundfile; print('soundfile OK')"),
    ]

    all_ok = True
    for name, code in checks:
        result = run([str(python), "-c", code], capture=True, check=False)
        if result.returncode == 0:
            print(f"    [+] {name}: {result.stdout.strip()}")
        else:
            print(f"    [-] {name}: FAILED")
            print(f"        {result.stderr.strip()}")
            all_ok = False

    if all_ok:
        print("[+] All checks passed.")
    else:
        print("[-] Some checks failed.")
        sys.exit(1)


def update(python):
    """Update all packages to latest compatible versions."""
    print("[*] Updating packages ...")

    # Update pip
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])

    # Update requirements
    core_req = REQUIREMENTS_DIR / "core.txt"
    if core_req.exists():
        run([str(python), "-m", "pip", "install", "--upgrade", "-r", str(core_req)])
        
    engine = os.environ.get("NSPEECH_ENGINE", "chatterbox")
    engine_req = REQUIREMENTS_DIR / f"{engine}.txt"
    if engine_req.exists():
        run([str(python), "-m", "pip", "install", "--upgrade", "-r", str(engine_req)])

    # Re-apply patches in case chatterbox was updated
    patch_chatterbox(python)

    print("[+] Update complete.")
    verify_installation(python)


# ── Commands ─────────────────────────────────────────────────────────────────


def cmd_install(args):
    """Fresh install."""
    print("=" * 60)
    print("nSpeech Service Installer")
    print("=" * 60)
    print()

    create_env_file()
    
    import nspeech.config
    engine = os.environ.get("NSPEECH_ENGINE", "chatterbox")

    create_venv()
    python = get_python()

    install_pytorch(python)
    install_requirements(python, engine=engine)
    patch_chatterbox(python)

    if args.models:
        download_models(python)

    verify_installation(python)

    print()
    print("=" * 60)
    print("Installation complete!")
    print("=" * 60)
    print()
    print("To start the server:")
    print("    python run.py")


def cmd_update(args):
    """Update existing installation."""
    if not VENV_DIR.exists():
        print("[!] No existing installation found. Run 'install' first.")
        sys.exit(1)

    python = get_python()
    update(python)


def cmd_verify(args):
    """Verify existing installation."""
    if not VENV_DIR.exists():
        print("[!] No installation found. Run 'install' first.")
        sys.exit(1)

    python = get_python()
    verify_installation(python)


def cmd_models(args):
    """Download model weights only."""
    if not VENV_DIR.exists():
        print("[!] No installation found. Run 'install' first.")
        sys.exit(1)

    python = get_python()
    download_models(python)


# ── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Install/update the nSpeech TTS service"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_install = subparsers.add_parser("install", help="Fresh install")
    p_install.add_argument("--models", action="store_true", help="Pre-download model weights")

    subparsers.add_parser("update", help="Update packages")
    subparsers.add_parser("verify", help="Verify installation")
    subparsers.add_parser("models", help="Download model weights")

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
