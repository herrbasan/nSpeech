"""Render an F5-TTS text/markdown file to WAV.

Usage: python render-f5tts.py <text.txt|text.md> <out.wav> [voice] [nfe_step] [speed]

Markdown files (.md) are cleaned: frontmatter stripped, headers get a trailing
period (so the title doesn't run into the first paragraph), bold/italic/link
markers removed.
"""
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from nspeech.engines.f5tts import F5TtsAdapter


def clean_markdown(text: str) -> str:
    """Strip markdown for speech. Headers get a trailing period so the
    duration estimator inserts a pause before the next paragraph."""
    # YAML frontmatter
    text = re.sub(r"(?s)^---\s*\n.*?\n---\s*\n", "", text)
    # Images (drop entirely), links (keep text)
    text = re.sub(r"!\[.*?\]\(.+?\)", "", text)
    text = re.sub(r"\[(.+?)\]\(.+?\)", r"\1", text)
    # Bold/italic
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"_(.+?)_", r"\1", text)
    # Code spans/blocks — drop content (reads poorly as TTS)
    text = re.sub(r"(?s)```.*?```", "", text)
    text = re.sub(r"`(.+?)`", r"\1", text)
    # Headers: strip '#' and add period if missing
    def _header(m):
        title = m.group(2).strip()
        if title and title[-1] not in ".!?…":
            title += "."
        return title + "\n"
    text = re.sub(r"(?m)^(#{1,6})\s+(.+)$", _header, text)
    # Horizontal rules → paragraph break
    text = re.sub(r"(?m)^\s*[-*_]{3,}\s*$", "\n", text)
    # Collapse 3+ newlines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


text_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
voice = sys.argv[3] if len(sys.argv) > 3 else "Melon"
nfe_step = int(sys.argv[4]) if len(sys.argv) > 4 else 32
speed = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0

text = text_path.read_text(encoding="utf-8").strip()
if text_path.suffix.lower() == ".md":
    text = clean_markdown(text)
print(f"Text: {len(text)} chars, voice: {voice}, nfe_step: {nfe_step}, speed: {speed}", flush=True)

adapter = F5TtsAdapter()
adapter.load_voice(voice)
t0 = time.time()
import numpy as _np
_parts = []
for pcm, is_final in adapter.generate(text, voice_name=voice, nfe_step=nfe_step, speed=speed):
    _parts.append(pcm.numpy())
    print(f"Chunk: {len(pcm)} samples ({len(pcm)/24000:.1f}s) at t={time.time()-t0:.1f}s", flush=True)
import soundfile as sf
sf.write(str(out_path), _np.concatenate(_parts), 24000)
print(f"DONE total {len(_np.concatenate(_parts))/24000:.1f}s in {time.time()-t0:.0f}s", flush=True)
