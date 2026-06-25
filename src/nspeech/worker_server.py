"""
nSpeech Worker Server — Phase 1

A standalone FastAPI/uvicorn server that wraps a single TTS engine adapter
and exposes engine-native HTTP endpoints. Designed to be spawned by the
Node management layer (Phase 2) with `--port 0` for dynamic port allocation.

Usage:
    venv/<engine>/env/Scripts/python -m nspeech.worker_server --engine kokoro --port 9001

The worker writes its bound port to a temp file (%TEMP%/nspeech-<engine>-<pid>.port)
and prints it as the first stdout line. Node reads the temp file (authoritative).
"""
import sys
import os
import argparse
import tempfile
import platform
from pathlib import Path


def _setup_path():
    """Ensure src/ is on sys.path so `nspeech` is importable."""
    src_dir = str(Path(__file__).parent.parent)
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)
    os.environ["PYTHONPATH"] = src_dir + os.pathsep + os.environ.get("PYTHONPATH", "")


def _write_port_file(engine, port):
    """Write the bound port to a temp file for Node to read."""
    temp_dir = tempfile.gettempdir()
    pid = os.getpid()
    filename = f"nspeech-{engine}-{pid}.port"
    path = Path(temp_dir) / filename
    path.write_text(str(port), encoding="utf-8")
    return path


def main():
    parser = argparse.ArgumentParser(description="nSpeech worker server")
    parser.add_argument("--engine", required=True, help="Engine name (kokoro, cosyvoice, etc.)")
    parser.add_argument("--port", type=int, default=0, help="Port to bind (0 = OS-assigned)")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind")
    args = parser.parse_args()

    _setup_path()

    # Set engine env BEFORE importing nspeech.config (which reads it)
    os.environ["NSPEECH_ENGINE"] = args.engine

    # Import after path and env are set
    from nspeech.logger import init as init_logger, get as get_logger
    init_logger(
        logs_dir=Path(__file__).parent.parent.parent / "logs",
        process_name=f"worker-{args.engine}",
    )
    log = get_logger()

    log.info(
        f"worker starting: engine={args.engine}",
        extra={"meta": {"engine": args.engine, "port": args.port}, "category": "worker"},
    )

    # Import and create the app — this triggers engine adapter loading
    from nspeech.worker_routes import create_app
    app = create_app(args.engine)

    import uvicorn

    # Find an available port
    import socket
    if args.port == 0:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind((args.host, 0))
        actual_port = sock.getsockname()[1]
        sock.close()
    else:
        actual_port = args.port

    # Write port file for Node to discover
    port_file = _write_port_file(args.engine, actual_port)

    # Print port as first stdout line (fallback for debugging)
    print(f"NSPEECH_WORKER_PORT={actual_port}", flush=True)
    print(f"NSPEECH_WORKER_PORT_FILE={port_file}", flush=True)

    log.info(
        f"worker bound: port={actual_port}",
        extra={"meta": {"port": actual_port, "port_file": str(port_file)}, "category": "worker"},
    )

    config = uvicorn.Config(
        app,
        host=args.host,
        port=actual_port,
        reload=False,
        timeout_graceful_shutdown=0,
        log_level="warning",  # uvicorn's own logging is noisy; we use nLogger
    )
    server = uvicorn.Server(config)

    try:
        server.run()
    finally:
        # Cleanup port file on shutdown
        try:
            port_file.unlink()
        except Exception:
            pass
        log.info("worker stopped", extra={"meta": {"engine": args.engine}, "category": "worker"})


if __name__ == "__main__":
    main()
