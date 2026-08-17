"""Probe MiniMax T2A streaming with a long text - log raw SSE/HTTP response.

Usage: python scripts/probe-minimax-stream.py <textfile> [voice]
"""
import json
import sys
import urllib.request
from pathlib import Path


def load_envkey():
    import re
    text = Path(".env").read_text(encoding="utf-8")
    m = re.search(r"^MINIMAX_API_KEY=(.+)$", text, re.MULTILINE)
    return m.group(1).strip()


text = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
voice = sys.argv[2] if len(sys.argv) > 2 else "English_expressive_narrator"
key = load_envkey()

body = {
    "model": "speech-2.8-turbo",
    "text": text[:8657] if len(text) > 8657 else text,
    "stream": True,
    "stream_options": {"exclude_aggregated_audio": True},
    "output_format": "hex",
    "voice_setting": {"voice_id": voice, "speed": 1.0, "vol": 1, "pitch": 0},
    "audio_setting": {"sample_rate": 24000, "bitrate": 128000, "format": "pcm", "channel": 1},
}

req = urllib.request.Request(
    "https://api.minimax.io/v1/t2a_v2",
    data=json.dumps(body).encode("utf-8"),
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
)

print(f"text chars: {len(body['text'])}, voice: {voice}")
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        print(f"HTTP {resp.status}")
        total_lines, data_lines, first = 0, 0, []
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").rstrip()
            total_lines += 1
            if line.startswith("data:"):
                data_lines += 1
                if len(first) < 3:
                    # show structure without dumping megabytes of hex
                    first.append(line[:300])
            elif line and len(first) < 8:
                first.append(line[:300])
        print(f"total lines: {total_lines}, data lines: {data_lines}")
        for l in first:
            print("  |", l)
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}")
    print(e.read().decode("utf-8", errors="replace")[:1000])
