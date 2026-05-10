"""
Chatterbox TTS Engine Adapter
Implements sentence-level chunking and caching using Chatterbox Multilingual.
Supports 23 languages via language_id parameter.
"""
import re
import time
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
from nspeech import config

LANGUAGE_MAP = {
    "de": "de", "en": "en", "es": "es", "fr": "fr", "it": "it",
    "ja": "ja", "ko": "ko", "zh": "zh", "ru": "ru", "ar": "ar",
    "da": "da", "el": "el", "fi": "fi", "he": "he", "hi": "hi",
    "ms": "ms", "nl": "nl", "no": "no", "pl": "pl", "pt": "pt",
    "sv": "sv", "sw": "sw", "tr": "tr",
}


class ChatterboxAdapter:
    """TTS engine adapter for Chatterbox Multilingual."""

    def __init__(self):
        try:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        except ImportError as e:
            print("REAL ERROR:", e)
            raise ImportError("Chatterbox is not installed. Run `pip install -r requirements/chatterbox.txt`.")
            
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = ChatterboxMultilingualTTS.from_pretrained(device=self.device)
        self.engine_name = "chatterbox"
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]:
        exaggeration = kwargs.get("exaggeration", 0.5)
        language = kwargs.get("language")
        language_id = LANGUAGE_MAP.get(language, "en") if language else "en"
        
        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
        if not sentences:
            sentences = [text]
            
        for i, sentence in enumerate(sentences):
            is_final = (i == len(sentences) - 1)
            chunk_tensor = self.model.generate(text=sentence, exaggeration=exaggeration, language_id=language_id)
            yield chunk_tensor, is_final

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]:
        """
        Clone a voice from reference audio.
        """
        start_time = time.time()
        exaggeration = kwargs.get("exaggeration", 0.5)
        
        # Compute conditionals
        self.model.prepare_conditionals(audio_path, exaggeration=exaggeration)
        
        # Save cache with engine-specific extension
        cache_filename = f"{voice_name}.{self.engine_name}.pt"
        cache_path = self.cache_dir / cache_filename
        self.model.conds.save(cache_path)
        
        file_size = cache_path.stat().st_size if cache_path.exists() else 0
        clone_time_ms = int((time.time() - start_time) * 1000)
        
        return {
            "voice_name": voice_name,
            "engine": self.engine_name,
            "cache_file": f"voices/{cache_filename}",
            "source_file": audio_path,
            "file_size_bytes": file_size,
            "clone_time_ms": clone_time_ms
        }

    def load_voice(self, voice_name: str) -> None:
        """
        Load voice conditionals from cache.
        """
        from chatterbox.tts import Conditionals

        cache_filename = f"{voice_name}.{self.engine_name}.pt"
        cache_path = self.cache_dir / cache_filename
        
        if not cache_path.exists():
            raise FileNotFoundError(f"Voice cache for '{voice_name}' not found at {cache_path}. Clone it first.")
            
        self.model.conds = Conditionals.load(cache_path, map_location=self.device)
