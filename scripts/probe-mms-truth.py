"""Probe: MMS forced alignment on a TRUTHFUL fixture (audio speaks exactly
the given text). Validates boundary precision vs faster-whisper word stamps.
"""
import sys
sys.path.insert(0, r"D:\DEV\nSpeech\src")
import io
import numpy as np
import soundfile as sf

PCM = r"D:\DEV\nSpeech\logs\chunk-test\parts\aligntext-real.pcm"
TEXT = open(r"D:\DEV\nSpeech\logs\chunk-test\parts\align-text.txt", encoding="utf-8").read()

pcm24, _ = sf.read(io.BytesIO(
    b"".join([])  # placeholder — read raw below
), dtype="float32") if False else (None, None)

raw = open(PCM, "rb").read()

# raw s16le 24kHz mono → float32
n = len(raw) // 2
ints = np.frombuffer(raw, dtype="<i2", count=n)
audio24 = ints.astype(np.float32) / 32768.0

from nspeech.stt_worker import forced_align, _resample
audio16 = _resample(audio24, 24000, 16000)

import time
t0 = time.perf_counter()
words = forced_align(audio16, 16000, TEXT)
dt = time.perf_counter() - t0
dur = len(audio16) / 16000
print(f"audio {dur:.1f}s | align {dt:.1f}s | words in/out: {len(TEXT.split())}/{len(words)}")
print("first 3:", [(w['word'], w['start'], w['end']) for w in words[:3]])
print("word 50-52 (boundary):")
for w in words[49:52]: print("  ", w)
print("last 2:", [(w['word'], w['start'], w['end']) for w in words[-2:]])
