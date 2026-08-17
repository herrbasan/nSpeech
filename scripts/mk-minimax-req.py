"""Build a >9800-char MiniMax test request from the failing German article."""
import json, sys
from pathlib import Path

src = Path("logs/chunk-test/the-intellectual-corset.md").read_text(encoding="utf-8")
text = src[:9970].ljust(9853, " ")
req = {"model": "minimax", "input": text, "voice": "English_expressive_narrator", "response_format": "mp3"}
Path("logs/minimax-req-long.json").write_text(json.dumps(req), encoding="utf-8")
print(f"input chars: {len(text)}")
