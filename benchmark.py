#!/usr/bin/env python3
"""
nSpeech Benchmark
=================
Benchmark the TTS engine and report VRAM usage.
"""
import subprocess
import sys
import time

sys.path.insert(0, "src")

import torch

from nspeech.tts import TTSEngine


def get_vram_mb():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True
        )
        return float(result.stdout.strip().split("\n")[0])
    except Exception:
        if torch.cuda.is_available():
            return torch.cuda.memory_allocated() / 1024 / 1024
        return 0


def main():
    print("=" * 60)
    print("nSpeech TTS Benchmark")
    print("=" * 60)
    print(f"GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'}")
    total_vram = 0
    if torch.cuda.is_available():
        total_vram = torch.cuda.get_device_properties(0).total_memory / 1024 / 1024 / 1024
        print(f"Total VRAM: {total_vram:.1f} GB")
    print()

    vram_baseline = get_vram_mb()
    print(f"Baseline VRAM: {vram_baseline:.1f} MB")
    print()

    # Load engine
    print("Loading TTS engine (Chatterbox)...")
    t0 = time.time()
    tts = TTSEngine(device="cuda")
    print(f"  Loaded in {time.time()-t0:.1f}s")
    vram_after_tts = get_vram_mb()
    print(f"  VRAM: {vram_after_tts:.1f} MB (delta: {vram_after_tts - vram_baseline:.1f} MB)")

    # Warmup
    _ = tts.generate("Warmup.")
    if torch.cuda.is_available():
        torch.cuda.synchronize()

    print()
    print("=" * 60)
    print("Running TTS benchmark...")
    print("=" * 60)

    test_phrases = [
        "Hello, how are you today?",
        "The weather is quite nice outside.",
        "Can you help me with a quick question?",
    ]

    print(f"{'#':>3} {'TTS':>8} {'VRAM':>10}")
    print("-" * 25)

    results = []
    for i, text in enumerate(test_phrases):
        vram_before = get_vram_mb()
        t0 = time.time()
        audio = tts.generate(text)
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        tts_latency = (time.time() - t0) * 1000
        vram_after = get_vram_mb()

        print(f"{i+1:>3} {tts_latency:>7.0f}ms {vram_after:>8.0f}MB")
        results.append(tts_latency)

    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"TTS latency:  mean={sum(results)/len(results):.0f}ms")
    print(f"TTS VRAM:     {vram_after_tts - vram_baseline:.1f} MB ({(vram_after_tts - vram_baseline)/1024:.2f} GB)")
    if total_vram > 0:
        print(f"Remaining:    {total_vram - (vram_after_tts - vram_baseline)/1024:.2f} GB")


if __name__ == "__main__":
    main()
