"""
Kokoro TTS Engine Adapter
Implements sentence-level chunking and voice caching using the Kokoro backend.
Thread-safe: serialize access to ONNX pipeline via lock to prevent empty
output under concurrent load.
"""
import re
import time
import threading
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
import numpy as np
from nspeech import config
from nspeech.logger import get as get_logger, error as log_error

class KokoroAdapter:
    """TTS engine adapter for Kokoro."""

    def __init__(self):
        try:
            from kokoro_onnx import Kokoro
        except ImportError as e:
            print("REAL ERROR:", e)
            raise ImportError("Kokoro ONNX is not installed. Run `pip install -r requirements/kokoro.txt`.")
            
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.engine_name = "kokoro"
        
        # Load Kokoro ONNX model
        model_dir = Path(config.NSPEECH_MODEL_DIR) if hasattr(config, "NSPEECH_MODEL_DIR") and config.NSPEECH_MODEL_DIR else Path("models")
        model_dir.mkdir(parents=True, exist_ok=True)
        
        model_path = model_dir / "kokoro-v1.0.onnx"
        voices_path = model_dir / "voices-v1.0.bin"
        
        if not model_path.exists() or not voices_path.exists():
            raise FileNotFoundError(
                f"Kokoro ONNX weights not found in {model_dir}.\n"
                f"Please place 'kokoro-v1.0.onnx' and 'voices-v1.0.bin' in {model_dir}."
            )
            
        self.pipeline = Kokoro(str(model_path), str(voices_path))
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        
        # Ensure voice directory exists
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.active_voices = {}
        
        # Thread safety: serialize access to ONNX pipeline and shared state.
        # Kokoro's create() has internal mutable buffers (phonemizer, voice cache)
        # that cause empty output under concurrent access.
        self._lock = threading.Lock()

    def load_voice(self, voice_name: str) -> None:
        """
        Load a cached voice embedding for subsequent generate() calls.
        Fails fast if the file `voices/<voice_name>.<engine_name>.pt` doesn't exist.
        """
        if voice_name in self.pipeline.get_voices():
            with self._lock:
                self.active_voices[voice_name] = voice_name
                self.current_voice = voice_name
            return

        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.pt"
        if not cache_path.exists():
            cache_path = self.cache_dir / "cache" / f"{voice_name}.{self.engine_name}.pt"
        if not cache_path.exists():
            raise FileNotFoundError(f"Voice cache not found: {voice_name}")
            
        data = torch.load(cache_path, weights_only=False)
        if isinstance(data, str):
            if data in self.pipeline.get_voices():
                with self._lock:
                    self.active_voices[voice_name] = data
                    self.current_voice = voice_name
                return
            data = self.pipeline.get_voice_style(data)
        if isinstance(data, torch.Tensor):
            data = data.cpu().numpy()
            
        with self._lock:
            self.active_voices[voice_name] = data
            self.current_voice = voice_name

    def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]:
        """
        Generate speech from text, chunking by sentences.
        Yields (pcm_tensor, is_final).
        Thread-safe: serializes access to the ONNX pipeline.
        """
        speed = kwargs.get("speed", 1.0)
        # Use the lastly loaded voice or fallback
        voice_name = kwargs.get("voice_name", getattr(self, "current_voice", "af_heart"))
        
        # Load from cache if not already in memory but exists on disk
        if voice_name not in self.active_voices:
            try:
                self.load_voice(voice_name)
            except FileNotFoundError:
                # Direct voice strings passed to Kokoro (pre-packaged voices)
                with self._lock:
                    self.active_voices[voice_name] = voice_name
                    self.current_voice = voice_name
                
        with self._lock:
            voice_data = self.active_voices[voice_name]
        if isinstance(voice_data, str):
            voice_data = self.pipeline.get_voice_style(voice_data)
        elif isinstance(voice_data, torch.Tensor):
            voice_data = voice_data.cpu().numpy()

        # Basic sentence splitting regex
        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
        if not sentences:
            sentences = [text]
            
        for i, sentence in enumerate(sentences):
            is_final = (i == len(sentences) - 1)
            
            # Serialize ONNX inference to prevent empty output from concurrent access
            with self._lock:
                audio_array, _ = self.pipeline.create(sentence, voice=voice_data, speed=speed)
            
            # Fail fast on empty output — indicates inference race or pipeline error
            if audio_array is None or len(audio_array) == 0:
                log_error("kokoro_empty_output", {
                    "sentence": sentence[:200],
                    "voice_name": voice_name,
                    "speed": speed,
                    "sentence_idx": i,
                    "total_sentences": len(sentences),
                    "full_text_len": len(text),
                }, "kokoro")
                raise RuntimeError(
                    f"Kokoro produced empty audio for sentence {i}/{len(sentences)} "
                    f"(voice={voice_name}, speed={speed}). "
                    f"Text: {sentence[:120]}..."
                )
            
            chunk_tensor = torch.from_numpy(audio_array).float()
                
            # Ensure 1D mono
            if chunk_tensor.ndim > 1:
                chunk_tensor = chunk_tensor.squeeze()
                
            yield chunk_tensor.cpu(), is_final

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]:
        """
        Clone a voice from reference audio.
        (Note: Official Kokoro pip package zero-shot extraction is complex;
        currently using placeholder to meet structual requirements and allow testing).
        """
        start_time = time.time()
        cache_filename = f"{voice_name}.{self.engine_name}.pt"
        cache_path = self.cache_dir / cache_filename
        
        # TODO: Implement true zero loop cloning for Kokoro if style/embedding extraction is added
        print(f"[Kokoro] Voice cloning is currently a stub for {voice_name}. Falling back to default voice.")
        # Save a valid fallback voice string instead of breaking ONNX
        torch.save("af_heart", cache_path)
        
        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name,
            "cache_file": str(cache_path),
            "clone_time_ms": clone_time_ms
        }
