import os
from pathlib import Path

def load_env_file(env_path: Path):
    """Load environment variables from a .env file (zero dependency)."""
    if not env_path.exists():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("'").strip('"')
                # Only set if not already in environment
                if key not in os.environ:
                    os.environ[key] = value

# Attempt to load .env from the project root
project_root = Path(__file__).parent.parent.parent.resolve()
load_env_file(project_root / ".env")

# ── Core Settings ────────────────────────────────────────────────────────────

REQUIRED_ENV_VARS = ("NSPEECH_ENGINE", "NSPEECH_VOICE_DIR", "NSPEECH_MODEL_DIR")

missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
if missing:
    engine_hint = os.environ.get("NSPEECH_ENGINE", "<unset>")
    raise RuntimeError(
        f"Worker cannot start: missing required env vars {missing}. "
        f"NSPEECH_ENGINE={engine_hint!r}. "
        f"The Node gateway is responsible for setting these per-engine "
        f"(venv/<engine>/voices, venv/<engine>/models). "
        f"Check server/engine/worker.js if you see this from a Node-spawned worker."
    )

NSPEECH_ENGINE = os.environ["NSPEECH_ENGINE"]
NSPEECH_VOICE_DIR = os.environ["NSPEECH_VOICE_DIR"]
NSPEECH_MODEL_DIR = os.environ["NSPEECH_MODEL_DIR"]


def _validate_engine_paths():
    """Best-effort check that voice/model dirs look right for the engine.
    Surfaces a clear error early instead of letting adapters raise FileNotFoundError
    deep inside model loading."""
    voice_path = Path(NSPEECH_VOICE_DIR)
    model_path = Path(NSPEECH_MODEL_DIR)

    # Voice dir must be inside venv/<engine>/voices
    expected_voice_suffix = f"venv{os.sep}{NSPEECH_ENGINE}{os.sep}voices"
    if expected_voice_suffix.lower() not in str(voice_path).lower():
        # Soft warning only — operators may have custom layouts.
        print(
            f"[config] warning: NSPEECH_VOICE_DIR={voice_path} "
            f"does not contain expected {expected_voice_suffix!r}. "
            f"If this is intentional, ignore."
        )

    if not voice_path.exists():
        raise RuntimeError(
            f"NSPEECH_VOICE_DIR does not exist: {voice_path}. "
            f"Create it or fix the env var."
        )


_validate_engine_paths()

NSPEECH_HOST = os.environ.get("NSPEECH_HOST", "127.0.0.1")
NSPEECH_PORT = int(os.environ.get("NSPEECH_PORT", "8000"))
NSPEECH_API_KEY = os.environ.get("NSPEECH_API_KEY", "")
NSPEECH_PRELOAD_MODEL = os.environ.get("NSPEECH_PRELOAD_MODEL", "false").lower() == "true"
NSPEECH_MODEL_IDLE_TIMEOUT_SEC = int(os.environ.get("NSPEECH_MODEL_IDLE_TIMEOUT_SEC", "0"))
NSPEECH_LOG_LEVEL = os.environ.get("NSPEECH_LOG_LEVEL", "INFO").upper()
NSPEECH_TRANSCODE_SAMPLE_RATE = int(os.environ.get("NSPEECH_TRANSCODE_SAMPLE_RATE", "24000"))
NSPEECH_TRANSCODE_BITRATE = os.environ.get("NSPEECH_TRANSCODE_BITRATE", "128k")

# Ensure runtime directories exist
Path(NSPEECH_VOICE_DIR).mkdir(parents=True, exist_ok=True)
Path(NSPEECH_MODEL_DIR).mkdir(parents=True, exist_ok=True)

# ── Patch HF_HOME ────────────────────────────────────────────────────────────
# We immediately set HF_HOME so any HuggingFace hub library import uses the 
# user-specified model directory instead of ~/.cache/huggingface
os.environ["HF_HOME"] = NSPEECH_MODEL_DIR
