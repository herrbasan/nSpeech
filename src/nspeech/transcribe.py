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
_backend = None


def transcribe(audio_path):
    """Transcribe an audio file to text using local Whisper.

    Prefers faster-whisper (ctranslate2, int8 CPU) when available;
    falls back to openai-whisper. Model loads lazily and stays resident.
    """
    global _model, _backend
    if _model is None:
        try:
            from faster_whisper import WhisperModel
            _model = WhisperModel("base", device="cpu", compute_type="int8")
            _backend = "faster"
        except ModuleNotFoundError:
            import whisper
            _model = whisper.load_model("base")
            _backend = "openai"

    try:
        if _backend == "faster":
            segments, _ = _model.transcribe(audio_path)
            text = " ".join(s.text.strip() for s in segments).strip()
        else:
            result = _model.transcribe(audio_path, fp16=False)
            text = result.get("text", "").strip()
        if text:
            print(f"[whisper:{_backend}] transcribed: {text[:80]}...")
        return text
    except Exception as e:
        print(f"[whisper] transcription failed: {e}")
        return ""
