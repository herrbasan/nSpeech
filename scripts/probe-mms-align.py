"""Probe: MMS_FA forced alignment against the real chunk-2 fixture."""
import sys
sys.path.insert(0, r"D:\DEV\nSpeech\src")
import numpy as np
import soundfile as sf
from nspeech.stt_worker import forced_align

t = open(r"D:\DEV\nSpeech\logs\chunk-test\parts\align-text.txt", encoding="utf-8").read()
pcm, sr = sf.read(r"D:\DEV\nSpeech\logs\chunk-test\parts\chunk2-full.wav", dtype="float32")
words = forced_align(pcm, sr, t)
print(f"input words: {len(t.split())} | aligned: {len(words)}")
overlap_n = len("Begin. The rest is negotiation with what you have begun, and negotiation is another word for living. Every conversation you will ever have, every system you will ever build, every person you will ever become starts the same way: someone moves first, and the universe quietly rearranges itself around the fact.".split())
b = words[overlap_n]
print(f"boundary word #{overlap_n}: {b}")
print("first 3:", words[:3])
print("overlap tail:", words[overlap_n-2:overlap_n+2])
