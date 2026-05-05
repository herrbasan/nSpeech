#!/usr/bin/env python3
"""
nSpeech Benchmark
=================
Benchmark the TTS engine and report VRAM usage.
Measures both TTFB (Time to First Byte/Chunk) and Total Synthesis Time.
"""
import subprocess
import sys
import time

sys.path.insert(0, "src")

import torch
from nspeech import config
from nspeech.tts import get_engine


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
    print("=" * 70)
    print("nSpeech TTS Benchmark")
    print("=" * 70)
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
    engine_name = config.NSPEECH_ENGINE
    print(f"Loading TTS engine ({engine_name})...")
    t0 = time.time()
    tts = get_engine(engine_name)
    print(f"  Loaded in {time.time()-t0:.1f}s")
    vram_after_tts = get_vram_mb()
    print(f"  VRAM: {vram_after_tts:.1f} MB (delta: {vram_after_tts - vram_baseline:.1f} MB)")

    # Warmup
    print("  Warming up model...")
    list(tts.generate("Warmup."))
    if torch.cuda.is_available():
        torch.cuda.synchronize()

    print()
    print("=" * 70)
    print("Running TTS stream benchmark...")
    print("=" * 70)

    test_phrases = [
        "Hello, how are you today?",
        "The weather is quite nice outside.",
        "Can you help me with a quick question?",
        "This is a longer sentence. It should be split by the internal chunker. Let's see how fast the first chunk streams out.",
    ]

    print(f"{'#':>3} {'TTFB (ms)':>12} {'Total (ms)':>12} {'VRAM (MB)':>10} {'Chunks':>8}")
    print("-" * 50)

    ttfb_results = []
    total_results = []
    
    for i, text in enumerate(test_phrases):
        t0 = time.time()
        generator = tts.generate(text)
        
        # Get first chunk (Time To First Byte / Audio)
        try:
            first_chunk, is_final = next(generator)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            ttfb_latency = (time.time() - t0) * 1000
            
            # Consume the rest
            chunks_count = 1
            for chunk, is_final in generator:
                chunks_count += 1
                
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            total_latency = (time.time() - t0) * 1000
            
        except StopIteration:
            ttfb_latency = 0
            total_latency = 0
            chunks_count = 0

        vram_after = get_vram_mb()

        print(f"{i+1:>3} {ttfb_latency:>10.0f}ms {total_latency:>10.0f}ms {vram_after:>8.0f}MB {chunks_count:>8}")
        ttfb_results.append(ttfb_latency)
        total_results.append(total_latency)

    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"TTFB latency:   mean={sum(ttfb_results)/len(ttfb_results):.0f}ms")
    print(f"Total latency:  mean={sum(total_results)/len(total_results):.0f}ms")
    print(f"Engine VRAM:    {vram_after_tts - vram_baseline:.1f} MB ({(vram_after_tts - vram_baseline)/1024:.2f} GB)")


if __name__ == "__main__":
    main()
