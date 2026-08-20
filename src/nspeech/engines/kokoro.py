"""
Kokoro TTS Engine Adapter
Implements sentence-level chunking and voice caching using the Kokoro backend.
Thread-safe: voice-state mutations are lock-protected. ONNX inference
(Session.run) is thread-safe per ONNX Runtime docs and left un-serialized.
If empty output reoccurs, fall back to per-thread pipeline instances.
"""
import re
import gc
import time
import threading
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
import numpy as np
from nspeech import config
from nspeech.logger import get as get_logger, error as log_error

# Kokoro voice quality tiers, from hexgrad's own voice metadata
# (kokoro.js/src/voices.js). `targetQuality` is the tier the voice was aimed
# at (A/B/C/D); `overallGrade` is the grade it actually achieved (A+…F+).
# English voices carry full grading; non-English voices are graded too but
# cluster lower (B–D). Only af_heart and af_bella reach A-tier.
VOICE_TIERS = {
    # en-us female
    "af_heart":   ("A", "A"),  "af_bella":   ("A", "A-"),
    "af_nicole":  ("B", "B-"), "af_aoede":   ("B", "C+"),
    "af_kore":    ("B", "C+"), "af_sarah":   ("B", "C+"),
    "af_alloy":   ("B", "C"),  "af_nova":    ("B", "C"),
    "af_sky":     ("B", "C-"), "af_jessica": ("C", "D"),
    "af_river":   ("C", "D"),
    # en-us male
    "am_fenrir":  ("B", "C+"), "am_michael": ("B", "C+"),
    "am_puck":    ("B", "C+"), "am_echo":    ("C", "D"),
    "am_eric":    ("C", "D"),  "am_liam":    ("C", "D"),
    "am_onyx":    ("C", "D"),  "am_santa":   ("C", "D-"),
    "am_adam":    ("D", "F+"),
    # en-gb
    "bf_emma":    ("B", "B-"), "bf_isabella": ("B", "C"),
    "bm_george":  ("B", "C"),  "bm_fable":    ("B", "C"),
    "bm_lewis":   ("C", "D+"), "bf_alice":    ("C", "D"),
    "bf_lily":    ("C", "D"),  "bm_daniel":   ("C", "D"),
    # ja
    "jf_alpha":      ("B", "C+"), "jf_gongitsune": ("B", "C"),
    "jf_nezumi":     ("B", "C-"), "jf_tebukuro":   ("B", "C"),
    "jm_kumo":       ("B", "C-"),
    # zh
    "zf_xiaobei":  ("C", "D"), "zf_xiaoni":   ("C", "D"),
    "zf_xiaoxiao": ("C", "D"), "zf_xiaoyi":   ("C", "D"),
    "zm_yunjian":  ("C", "D"), "zm_yunxi":    ("C", "D"),
    "zm_yunxia":   ("C", "D"), "zm_yunyang":  ("C", "D"),
    # es
    "ff_siwis": ("B", "B-"), "ef_dora":  ("C", "D"),
    "em_alex":  ("C", "D"),  "em_santa": ("C", "D"),
    # hi
    "hf_alpha": ("B", "C"), "hf_beta": ("B", "C"),
    "hm_omega": ("B", "C"), "hm_psi":  ("B", "C"),
    # it
    "if_sara":   ("B", "C"), "im_nicola": ("B", "C"),
    # pt-br
    "pf_dora":  ("C", "D"), "pm_alex":  ("C", "D"), "pm_santa": ("C", "D"),
}

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
        
        # Lock protects voice-state mutations only (active_voices dict,
        # current_voice). ONNX inference runs outside the lock — ONNX
        # Runtime's Session.run() is documented as thread-safe.
        # If empty output reoccurs, the race is in Kokoro's ONNX wrapper
        # internals; fallback: N pipeline instances (one per worker thread).
        self._voice_lock = threading.Lock()

    def load_voice(self, voice_name: str) -> None:
        """
        Load a cached voice embedding for subsequent generate() calls.
        Fails fast if the file `voices/<voice_name>.<engine_name>.pt` doesn't exist.
        """
        if voice_name in self.pipeline.get_voices():
            with self._voice_lock:
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
                with self._voice_lock:
                    self.active_voices[voice_name] = data
                    self.current_voice = voice_name
                return
            data = self.pipeline.get_voice_style(data)
        if isinstance(data, torch.Tensor):
            data = data.cpu().numpy()
            
        with self._voice_lock:
            self.active_voices[voice_name] = data
            self.current_voice = voice_name

    def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]:
        """
        Generate speech from text, chunking by sentences.
        Yields (pcm_tensor, is_final).
        Thread-safe: voice-state resolution is lock-protected; ONNX inference
        runs concurrently (Session.run() is thread-safe per ONNX Runtime docs).
        """
        speed = kwargs.get("speed", 1.0)
        voice_name = kwargs.get("voice_name", getattr(self, "current_voice", "af_heart"))
        
        # ── Voice resolution (lock-protected dict access only) ──────────
        # Lock guards active_voices dict reads/writes. Data loading and
        # style extraction run unlocked — they're I/O or pure computation.
        with self._voice_lock:
            voice_data = self.active_voices.get(voice_name)
        
        if voice_data is None:
            try:
                self.load_voice(voice_name)
            except FileNotFoundError:
                with self._voice_lock:
                    self.active_voices[voice_name] = voice_name
                    self.current_voice = voice_name
            
            with self._voice_lock:
                voice_data = self.active_voices[voice_name]
        
        if isinstance(voice_data, str):
            voice_data = self.pipeline.get_voice_style(voice_data)
        elif isinstance(voice_data, torch.Tensor):
            voice_data = voice_data.cpu().numpy()
        
        # voice_data is now a local numpy array — immutable, safe for
        # concurrent use across threads without any lock.

        # Basic sentence splitting regex
        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
        if not sentences:
            sentences = [text]
            
        for i, sentence in enumerate(sentences):
            is_final = (i == len(sentences) - 1)
            
            # ONNX inference — no lock. Session.run() is thread-safe.
            # voice_data is a local numpy array, not shared state.
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

    def list_voices(self) -> list:
        """
        Return the engine's native voice catalog (Kokoro's 54 built-in voices).
        Each voice carries `tier` (target quality A/B/C/D) and `grade`
        (achieved grade) from hexgrad's voice metadata. Cloned/blended voices
        are merged in by the worker after this returns.
        """
        try:
            names = self.pipeline.get_voices()
        except Exception:
            return []
        voices = []
        for n in names:
            tier, grade = VOICE_TIERS.get(n, (None, None))
            v = {"voice_id": n, "name": n, "category": "builtin", "voice_type": "builtin"}
            if tier is not None:
                v["tier"] = tier
                v["grade"] = grade
            voices.append(v)
        return voices

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

    def unload(self) -> None:
        """Release ONNX session and cached tensors to free VRAM."""
        self.pipeline = None
        self.active_voices.clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
