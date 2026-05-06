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
import platform
from pathlib import Path


def _resolve_python():
    script = Path(__file__).resolve()
    if platform.system() == "Windows":
        venv_python = script.parent / "venv" / "Scripts" / "python.exe"
    else:
        venv_python = script.parent / "venv" / "bin" / "python"
    if venv_python.exists() and Path(sys.executable).resolve() != venv_python:
        raise SystemExit(subprocess.call([str(venv_python), str(script)] + sys.argv[1:]))


if __name__ == "__main__":
    _resolve_python()

sys.path.insert(0, str(Path(__file__).parent / "src"))

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
        
        # 1. Test PCM TTFB (Raw Generator)
        generator = tts.generate(text)
        try:
            first_chunk, is_final = next(generator)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            ttfb_pcm = (time.time() - t0) * 1000
            
            chunks_count = 1
            for chunk, done in generator:
                chunks_count += 1
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            total_pcm = (time.time() - t0) * 1000
        except StopIteration:
            ttfb_pcm = total_pcm = chunks_count = 0

        # 2. Test Transcoding TTFB using PyAV (MP3)
        import av
        import io
        t0 = time.time()
        output_io = io.BytesIO()
        container = av.open(output_io, mode='w', format='mp3')
        stream = container.add_stream('libmp3lame', rate=24000)
        generator_mp3 = tts.generate(text)
        ttfb_mp3 = 0

        try:
            for c_idx, (chunk_tensor, is_final) in enumerate(generator_mp3):
                audio_int16 = (chunk_tensor.squeeze().cpu().numpy() * 32767.0).astype("int16")
                frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format='s16', layout='mono')
                frame.sample_rate = 24000
                for packet in stream.encode(frame):
                    container.mux(packet)
                
                if c_idx == 0:
                    if torch.cuda.is_available():
                        torch.cuda.synchronize()
                    ttfb_mp3 = (time.time() - t0) * 1000
                    
            for packet in stream.encode():
                container.mux(packet)
            container.close()
            total_mp3 = (time.time() - t0) * 1000
            
        except StopIteration:
            ttfb_mp3 = total_mp3 = 0
            
        vram_after = get_vram_mb()

        print(f"Phrase {i+1}:")
        print(f"  PCM: {ttfb_pcm:>5.0f}ms (First Chunk) -> {total_pcm:>5.0f}ms (Total)")
        print(f"  MP3: {ttfb_mp3:>5.0f}ms (First Chunk) -> {total_mp3:>5.0f}ms (Total)  (+{ttfb_mp3 - ttfb_pcm:>2.0f}ms added latency)")
        
        ttfb_results.append(ttfb_pcm)
        total_results.append(total_pcm)
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"TTFB latency:   mean={sum(ttfb_results)/len(ttfb_results):.0f}ms")
    print(f"Total latency:  mean={sum(total_results)/len(total_results):.0f}ms")
    print(f"Engine VRAM:    {vram_after_tts - vram_baseline:.1f} MB ({(vram_after_tts - vram_baseline)/1024:.2f} GB)")


if __name__ == "__main__":
    main()
