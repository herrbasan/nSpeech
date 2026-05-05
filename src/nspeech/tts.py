"""
Chatterbox TTS wrapper with voice caching.
"""
import time
from pathlib import Path

import torch
from nspeech import config


class TTSEngine:
    """Text-to-speech engine using Chatterbox."""

    def __init__(self, device="cuda"):
        from chatterbox.tts import ChatterboxTTS

        self.device = device if torch.cuda.is_available() else "cpu"
        self.model = ChatterboxTTS.from_pretrained(device=self.device)
        self.sr = self.model.sr
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)

    def generate(self, text: str, exaggeration: float = 0.5) -> torch.Tensor:
        """Generate speech from text."""
        return self.model.generate(text=text, exaggeration=exaggeration)

    def clone_voice(self, audio_path: str, exaggeration: float = 0.5) -> None:
        """Clone a voice from an audio file."""
        self.model.prepare_conditionals(audio_path, exaggeration=exaggeration)

    def save_voice_cache(self, name: str) -> Path:
        """Save current voice conditionals to cache."""
        cache_path = self.cache_dir / f"{name}.pt"
        self.model.conds.save(cache_path)
        return cache_path

    def load_voice_cache(self, name: str) -> None:
        """Load voice conditionals from cache."""
        from chatterbox.tts import Conditionals

        cache_path = self.cache_dir / f"{name}.pt"
        if not cache_path.exists():
            raise FileNotFoundError(f"Voice cache not found: {cache_path}")
        self.model.conds = Conditionals.load(cache_path, map_location=self.device)
