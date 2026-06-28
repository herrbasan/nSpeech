"""
nLogger-compatible JSON Lines logger for Python.
Format: {"ts":"ISO","level":"LEVEL","type":"Category","msg":"text","meta":{},"session":"id"}

Emits to stdout ONLY. The Node management layer is the single disk writer
(logs/main-0.log); it reads this process's stdout line-by-line and fans every
JSONL line into the unified combined log, tagged with the engine. This avoids
two processes rotating the same file and gives one place to look across all
engines. Engine-internal noise (loguru/torch/onnx) lands on stderr and is
wrapped by Node as engine.<name>.stderr entries.
"""
import json
import logging
import sys
import uuid
from datetime import datetime, timezone


_session_id = uuid.uuid4().hex[:8]
_current_process = "main"


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "type": getattr(record, "category", _current_process),
            "msg": record.getMessage(),
            "meta": getattr(record, "meta", {}),
            "session": _session_id,
        }
        if record.exc_info and record.exc_info[0]:
            entry["meta"]["traceback"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


_root_logger = None


def init(logs_dir=None, process_name="main"):
    # logs_dir is accepted for backward compatibility but ignored: this process
    # no longer writes log files. Node aggregates stdout into the combined log.
    global _root_logger, _current_process
    _current_process = process_name

    logger = logging.getLogger("nspeech")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    formatter = JsonFormatter()

    # stdout is the single log channel. Node parses these JSONL lines and
    # forwards them into the unified combined log (logs/main-0.log).
    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.INFO)
    console.setFormatter(formatter)
    logger.addHandler(console)

    _root_logger = logger
    return logger


def get():
    if _root_logger is None:
        return init()
    return _root_logger


def info(msg, meta=None, category=None):
    r = get().info(msg, extra={"meta": meta or {}, "category": category or _current_process})


def warn(msg, meta=None, category=None):
    r = get().warning(msg, extra={"meta": meta or {}, "category": category or _current_process})


def error(msg, meta=None, category=None):
    r = get().error(msg, extra={"meta": meta or {}, "category": category or _current_process})


def debug(msg, meta=None, category=None):
    r = get().debug(msg, extra={"meta": meta or {}, "category": category or _current_process})
