"""
Chatterbox TTS Engine Adapter
Three-model architecture:
- Turbo (350M): English, paralinguistic tags [laugh][cough], fastest
- English (500M): English, exaggeration/cfg tuning
- Multilingual (500M): 23 languages, auto-selected for non-English
Voice caches: .turbo.pt (Turbo), .chatterbox.pt (Eng/MTL)
"""
import re
import time
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import numpy as np
import torch
from nspeech import config

import librosa
_orig_librosa_load = librosa.load
_orig_librosa_resample = librosa.resample
def _load_f32(path, sr=None, *args, **kwargs):
    y, r = _orig_librosa_load(path, sr=sr, *args, **kwargs)
    return y.astype(np.float32), r
def _resample_f32(y, *args, **kwargs):
    return _orig_librosa_resample(y.astype(np.float32), *args, **kwargs).astype(np.float32)
librosa.load = _load_f32
librosa.resample = _resample_f32

LANGUAGE_MAP = {
    "de": "de", "es": "es", "fr": "fr", "it": "it", "ja": "ja",
    "ko": "ko", "zh": "zh", "ru": "ru", "ar": "ar", "da": "da",
    "el": "el", "fi": "fi", "he": "he", "hi": "hi", "ms": "ms",
    "nl": "nl", "no": "no", "pl": "pl", "pt": "pt", "sv": "sv",
    "sw": "sw", "tr": "tr",
    # Friendly aliases
    "german": "de", "english": "en", "spanish": "es", "french": "fr",
    "italian": "it", "japanese": "ja", "korean": "ko", "chinese": "zh",
    "russian": "ru", "arabic": "ar", "danish": "da", "dutch": "nl",
    "finnish": "fi", "hebrew": "he", "hindi": "hi", "norwegian": "no",
    "polish": "pl", "portuguese": "pt", "swedish": "sv", "turkish": "tr",
}


class ChatterboxAdapter:
    """TTS engine adapter for Chatterbox with three-model support."""

    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.engine_name = "chatterbox"
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self._turbo_model = None
        self._eng_model = None
        self._mtl_model = None
        self._active_model = None
        self._loaded_voice = None
        self._current_model_type = None

    @property
    def model(self):
        return self._active_model

    def _get_turbo_model(self):
        if self._turbo_model is None:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            self._turbo_model = ChatterboxTurboTTS.from_pretrained(device=self.device)
        return self._turbo_model

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

    def _cache_ext(self, model_type):
        return "turbo" if model_type == "turbo" else "chatterbox"

    def _cache_path(self, voice_name, model_type):
        return self.cache_dir / f"{voice_name}.{self._cache_ext(model_type)}.pt"

    def _resolve_model(self, language, model):
        if model == "turbo":
            return "turbo", self._get_turbo_model()
        if model == "eng":
            return "eng", self._get_eng_model()
        if language and LANGUAGE_MAP.get(language):
            return "mtl", self._get_mtl_model()
        return "eng", self._get_eng_model()

    def load_voice(self, voice_name, model=None):
        mt, mdl = self._resolve_model(None, model or self._current_model_type or "eng")
        self._current_model_type = mt
        cache_path = self._cache_path(voice_name, mt)
        if not cache_path.exists():
            wav_path = self.cache_dir / f"{voice_name}.wav"
            if wav_path.exists():
                self.clone(str(wav_path), voice_name, model=mt)
                return
            raise FileNotFoundError(f"Voice '{voice_name}' not found and no .wav to re-clone from.")
        self._loaded_voice = voice_name
        self._load_conds(mdl, mt, cache_path)

    def _load_conds(self, model, model_type, cache_path):
        if model_type == "turbo":
            from chatterbox.tts_turbo import Conditionals
        else:
            from chatterbox.tts import Conditionals
        model.conds = Conditionals.load(cache_path, map_location=self.device)

    def clone(self, audio_path, voice_name, **kwargs):
        start_time = time.time()
        model_type = kwargs.get("model", "eng")
        _, model = self._resolve_model(None, model_type)

        model.prepare_conditionals(audio_path, exaggeration=kwargs.get("exaggeration", 0.5), norm_loudness=False) if model_type == "turbo" else model.prepare_conditionals(audio_path, exaggeration=kwargs.get("exaggeration", 0.5))
        self._active_model = model
        self._current_model_type = model_type

        cache_path = self._cache_path(voice_name, model_type)
        model.conds.save(cache_path)

        self._loaded_voice = voice_name
        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name, "engine": self.engine_name,
            "cache_file": str(cache_path), "clone_time_ms": clone_time_ms,
        }

    def generate(self, text, **kwargs):
        model_type, model = self._resolve_model(
            kwargs.get("language"), kwargs.get("model")
        )
        self._active_model = model

        # If a voice was loaded but for a different model type, rehydrate
        # conditionals onto the newly resolved model (e.g. voice cloned with
        # "eng" model, now generating with "mtl" because language is non-English).
        if self._loaded_voice and model_type != self._current_model_type:
            cache_path = self._cache_path(self._loaded_voice, model_type)
            if cache_path.exists():
                self._load_conds(model, model_type, cache_path)

        self._current_model_type = model_type

        exaggeration = kwargs.get("exaggeration", 0.5)
        language = kwargs.get("language")
        language_id = LANGUAGE_MAP.get(language, "en") if language else "en"

        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
        if not sentences:
            sentences = [text]

        for i, sentence in enumerate(sentences):
            is_final = (i == len(sentences) - 1)
            if model_type == "turbo":
                chunk_tensor = model.generate(text=sentence, audio_prompt_path="")
            elif model_type == "mtl":
                chunk_tensor = model.generate(text=sentence, exaggeration=exaggeration, language_id=language_id)
            else:
                chunk_tensor = model.generate(text=sentence, exaggeration=exaggeration)
            yield chunk_tensor, is_final

    def list_voices(self) -> list:
        """Chatterbox has no native voice catalog — all voices are user-cloned.
        Return [] so the worker falls through to its directory-scan fallback."""
        return []


# Module-level helper kept here so existing imports keep working.