"""
Chatterbox TTS Engine Adapter

Each adapter instance is bound to ONE model type at construction:
- turbo (350M): English, paralinguistic tags [laugh][cough], fastest
- eng   (500M): English, exaggeration/cfg tuning
- mtl   (500M): 23 languages

Node spawns separate worker processes for chatterbox-turbo, chatterbox-eng,
and chatterbox-mtl. Each has its own voice directory. Voice caches use a
uniform .pt extension — no cross-model confusion.

Voice cache: <voice_name>.pt  (conditionals extracted by this model only)
"""
import re
import gc
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

# Maps model_type → (module_path, class_name, conditionals_module)
MODEL_SPECS = {
    "turbo": ("chatterbox.tts_turbo", "ChatterboxTurboTTS", "chatterbox.tts_turbo"),
    "eng":   ("chatterbox.tts",       "ChatterboxTTS",      "chatterbox.tts"),
    "mtl":   ("chatterbox.mtl_tts",   "ChatterboxMultilingualTTS", "chatterbox.tts"),
}


class ChatterboxAdapter:
    """TTS engine adapter for a single Chatterbox model variant.

    Bound to one model_type at construction. Loads only that model.
    """

    def __init__(self, model_type="eng"):
        if model_type not in MODEL_SPECS:
            raise ValueError(f"Unknown chatterbox model_type: {model_type}. Must be one of {list(MODEL_SPECS)}")
        self.model_type = model_type
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.engine_name = f"chatterbox-{model_type}"
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self._model = None
        self._loaded_voice = None

    @property
    def model(self):
        return self._model

    def _get_model(self):
        if self._model is None:
            module_path, class_name, _ = MODEL_SPECS[self.model_type]
            mod = __import__(module_path, fromlist=[class_name])
            cls = getattr(mod, class_name)
            self._model = cls.from_pretrained(device=self.device)
        return self._model

    def _cache_path(self, voice_name):
        return self.cache_dir / f"{voice_name}.pt"

    def load_voice(self, voice_name, **kwargs):
        model = self._get_model()
        cache_path = self._cache_path(voice_name)
        if not cache_path.exists():
            wav_path = self.cache_dir / f"{voice_name}.wav"
            if wav_path.exists():
                self.clone(str(wav_path), voice_name)
                return
            raise FileNotFoundError(f"Voice '{voice_name}' not found and no .wav to re-clone from.")
        self._loaded_voice = voice_name
        self._load_conds(model, cache_path)

    def _load_conds(self, model, cache_path):
        _, _, conds_module = MODEL_SPECS[self.model_type]
        mod = __import__(conds_module, fromlist=["Conditionals"])
        model.conds = mod.Conditionals.load(cache_path, map_location=self.device)

    def clone(self, audio_path, voice_name, **kwargs):
        start_time = time.time()
        model = self._get_model()
        exaggeration = kwargs.get("exaggeration", 0.5)

        if self.model_type == "turbo":
            model.prepare_conditionals(audio_path, exaggeration=exaggeration, norm_loudness=False)
        else:
            model.prepare_conditionals(audio_path, exaggeration=exaggeration)

        cache_path = self._cache_path(voice_name)
        model.conds.save(cache_path)

        self._loaded_voice = voice_name
        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name, "engine": self.engine_name,
            "cache_file": str(cache_path), "clone_time_ms": clone_time_ms,
        }

    def generate(self, text, **kwargs):
        model = self._get_model()
        exaggeration = kwargs.get("exaggeration", 0.5)
        language = kwargs.get("language")
        language_id = LANGUAGE_MAP.get(language, "en") if language else "en"

        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
        if not sentences:
            sentences = [text]

        for i, sentence in enumerate(sentences):
            is_final = (i == len(sentences) - 1)
            if self.model_type == "turbo":
                chunk_tensor = model.generate(text=sentence, audio_prompt_path="")
            elif self.model_type == "mtl":
                chunk_tensor = model.generate(text=sentence, exaggeration=exaggeration, language_id=language_id)
            else:
                chunk_tensor = model.generate(text=sentence, exaggeration=exaggeration)
            yield chunk_tensor, is_final

    def list_voices(self) -> list:
        """Chatterbox has no native voice catalog — all voices are user-cloned.
        Return [] so the worker falls through to its directory-scan fallback."""
        return []

    def is_loaded(self) -> bool:
        return self._model is not None

    def unload(self) -> None:
        """Release model reference and free VRAM."""
        self._model = None
        self._loaded_voice = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


# Module-level helper kept here so existing imports keep working.