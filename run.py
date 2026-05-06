import sys
import os
import platform
from pathlib import Path


def _resolve_python():
    script = Path(__file__).resolve()
    if platform.system() == "Windows":
        venv_python = script.parent / "venv" / "Scripts" / "python.exe"
    else:
        venv_python = script.parent / "venv" / "bin" / "python"
    if venv_python.exists() and Path(sys.executable).resolve() != venv_python:
        import subprocess
        raise SystemExit(subprocess.call([str(venv_python), str(script)] + sys.argv[1:]))


if __name__ == "__main__":
    _resolve_python()

    import uvicorn

    src_dir = str(Path(__file__).parent / "src")
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)

    os.environ["PYTHONPATH"] = src_dir + os.pathsep + os.environ.get("PYTHONPATH", "")

    print("=========================================")
    print("      Starting nSpeech API Server        ")
    print("=========================================")
    print("• Dashboard: http://127.0.0.1:8000/")
    print("• Stop Server: Press Ctrl+C")
    print("=========================================\n")

    try:
        uvicorn.run("nspeech.server:app", host="127.0.0.1", port=8000, reload=False)
    except KeyboardInterrupt:
        print("\nShutting down nSpeech gracefully...")
