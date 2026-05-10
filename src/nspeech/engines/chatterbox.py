"""
Chatterbox TTS Engine Adapter
Dual-model: English-only for quality, Multilingual for 23 languages.
Lazy-loads the multilingual model only when a non-English language is requested.
"""
import re
import time
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
from nspeech import config

LANGUAGE_MAP = {
    "de": "de", "es": "es", "fr": "fr", "it": "it", "ja": "ja",
    "ko": "ko", "zh": "zh", "ru": "ru", "ar": "ar", "da": "da",
    "el": "el", "fi": "fi", "he": "he", "hi": "hi", "ms": "ms",
    "nl": "nl", "no": "no", "pl": "pl", "pt": "pt", "sv": "sv",
    "sw": "sw", "tr": "tr",
}


class ChatterboxAdapter:
    """TTS engine adapter for Chatterbox with dual-model support."""

    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.engine_name = "chatterbox"
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self._eng_model = None
        self._mtl_model = None
        self._active_model = None
        self._loaded_voice = None

    @property
    def model(self):
        return self._active_model

    def _get_eng_model(self):
        if self._eng_model is None:
            from chatterbox.tts import ChatterboxTTS
            self._eng_model = ChatterboxTTS.from_pretrained(device=self.device)
        return self._eng_model

    def _get_mtl_model(self):
        if self._mtl_model is None:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            self._mtl_model = ChatterboxMultilingualTTS.from_pretrained(device=self.device)
        return self._mtl_model

    def _switch_model(self, language):
        if language and LANGUAGE_MAP.get(language):
            self._active_model = self._get_mtl_model()
        else:
            self._active_model = self._get_eng_model()
        if self._loaded_voice:
            self._restore_voice()

    def _restore_voice(self):
        from chatterbox.tts import Conditionals
        cache_path = self.cache_dir / f"{self._loaded_voice}.{self.engine_name}.pt"
        if cache_path.exists():
            self._eng_model.conds = Conditionals.load(cache_path, map_location=self.device)
            if self._mtl_model:
                self._mtl_model.conds = Conditionals.load(cache_path, map_location=self.device)

    def load_voice(self, voice_name):
        from chatterbox.tts import Conditionals
        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.pt"
        if not cache_path.exists():
            raise FileNotFoundError(f"Voice cache for '{voice_name}' not found at {cache_path}.")
        self._loaded_voice = voice_name
        if self._eng_model:
            self._eng_model.conds = Conditionals.load(cache_path, map_location=self.device)
        if self._mtl_model:
            self._mtl_model.conds = Conditionals.load(cache_path, map_location=self.device)

    def clone(self, audio_path, voice_name, **kwargs):
        start_time = time.time()
        exaggeration = kwargs.get("exaggeration", 0.5)

        model = self._get_eng_model()
        model.prepare_conditionals(audio_path, exaggeration=exaggeration)
        self._active_model = model

        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.pt"
        model.conds.save(cache_path)

        self._loaded_voice = voice_name
        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name, "engine": self.engine_name,
            "cache_file": str(cache_path), "clone_time_ms": clone_time_ms,
        }

    def generate(self, text, **kwargs):
        exaggeration = kwargs.get("exaggeration", 0.5)
        language = kwargs.get("language")
        language_id = LANGUAGE_MAP.get(language, "en") if language else "en"

        self._switch_model(language)

        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
        if not sentences:
            sentences = [text]

        for i, sentence in enumerate(sentences):
            is_final = (i == len(sentences) - 1)
            if language and LANGUAGE_MAP.get(language):
                chunk_tensor = self._mtl_model.generate(text=sentence, exaggeration=exaggeration, language_id=language_id)
            else:
                chunk_tensor = self._eng_model.generate(text=sentence, exaggeration=exaggeration)
            yield chunk_tensor, is_final
