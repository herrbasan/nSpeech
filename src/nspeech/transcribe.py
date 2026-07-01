"""
Local Whisper transcription — oneshot, CPU-bound, lazy-loaded.

Used by engine adapters to auto-transcribe reference audio during voice
cloning. The model loads on first call and stays resident for the worker's
lifetime. Uses the 'base' model (~74MB) — fast on CPU, accurate enough for
short reference clips (typically 5-30s).

No external service dependency. No network calls. Runs entirely inside the
engine worker process.
"""
import torch

_model = None


def transcribe(audio_path):
    """Transcribe an audio file to text using local Whisper.

    Returns the transcribed string, or empty string on failure.
    The model loads lazily on first call (~2-3s on CPU) and stays resident.
    """
    global _model
    if _model is None:
        import whisper
        _model = whisper.load_model("base")

    try:
        # fp16=False forces CPU float32 — GPU engines may have CUDA available
        # but Whisper on CPU is fast enough for short clips and avoids VRAM
        # contention with the TTS model.
        result = _model.transcribe(audio_path, fp16=False)
        text = result.get("text", "").strip()
        if text:
            print(f"[whisper] transcribed: {text[:80]}...")
        return text
    except Exception as e:
        print(f"[whisper] transcription failed: {e}")
        return ""
