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

try:
    NSPEECH_ENGINE = os.environ["NSPEECH_ENGINE"]
    NSPEECH_VOICE_DIR = os.environ["NSPEECH_VOICE_DIR"]
    NSPEECH_MODEL_DIR = os.environ["NSPEECH_MODEL_DIR"]
except KeyError as e:
    raise RuntimeError(f"Missing required explicitly configured environment variable: {e}")

NSPEECH_HOST = os.environ.get("NSPEECH_HOST", "127.0.0.1")
NSPEECH_PORT = int(os.environ.get("NSPEECH_PORT", "8000"))
NSPEECH_API_KEY = os.environ.get("NSPEECH_API_KEY", "")
NSPEECH_PRELOAD_MODEL = os.environ.get("NSPEECH_PRELOAD_MODEL", "false").lower() == "true"
NSPEECH_MODEL_IDLE_TIMEOUT_SEC = int(os.environ.get("NSPEECH_MODEL_IDLE_TIMEOUT_SEC", "0"))
NSPEECH_LOG_LEVEL = os.environ.get("NSPEECH_LOG_LEVEL", "INFO").upper()

# Ensure runtime directories exist
Path(NSPEECH_VOICE_DIR).mkdir(parents=True, exist_ok=True)
Path(NSPEECH_MODEL_DIR).mkdir(parents=True, exist_ok=True)

# ── Patch HF_HOME ────────────────────────────────────────────────────────────
# We immediately set HF_HOME so any HuggingFace hub library import uses the 
# user-specified model directory instead of ~/.cache/huggingface
os.environ["HF_HOME"] = NSPEECH_MODEL_DIR
