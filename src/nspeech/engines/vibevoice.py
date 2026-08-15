"""
VibeVoice Engine Adapter

Microsoft Research's long-form conversational TTS (community-maintained fork).
LLM (Qwen2.5) + diffusion head architecture. Generates multi-speaker dialogue
from text scripts. Designed for podcast/conversation generation, not low-latency
TTS — batch generation only, no streaming.

Output: 24kHz mono (matches nSpeech standard — no resampling needed).

Voice model: reference-audio-based voice cloning. Each "voice" is a speaker
name mapped to a reference audio file. The text input format uses speaker
labels: "Speaker1: text\\nSpeaker2: text".

For single-speaker use (simple TTS), the text is wrapped with a speaker label
and the default voice is used.

This engine is intended for Arena slide rendering and long-form generation
where quality and conversational flow matter more than latency.
"""
import gc
import re
import time
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
from nspeech import config


class VibevoiceAdapter:
    """TTS engine adapter for VibeVoice 1.5B."""

    def __init__(self):
        self.engine_name = "vibevoice"
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._model = None
        self._processor = None
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _model_dir(self) -> Path:
        """VibeVoice model weights location."""
        model_dir = Path(config.NSPEECH_MODEL_DIR)
        vv_dir = model_dir / "VibeVoice"
        if not vv_dir.exists():
            raise FileNotFoundError(
                f"VibeVoice model not found at {vv_dir}\n"
                f"Run: python install.py install --engine vibevoice --models"
            )
        return vv_dir

    def _load_model(self):
        """Lazy-load VibeVoice model + processor on first request."""
        if self._model is not None:
            return

        model_path = str(self._model_dir())
        print(f"Loading VibeVoice model from {model_path} ...")

        from vibevoice.modular.modeling_vibevoice_inference import (
            VibeVoiceForConditionalGenerationInference,
        )
        from vibevoice.processor.vibevoice_processor import VibeVoiceProcessor

        # CUDA uses bfloat16; CPU/MPS use float32.
        # flash-attn is opt-in via NSPEECH_VIBEVOICE_ATTN=flash_attention_2 —
        # there is no prebuilt flash-attn wheel for Windows on PyPI, so sdpa
        # (PyTorch native, still fused/efficient) is the default everywhere.
        import os
        if self.device == "cuda":
            load_dtype = torch.bfloat16
        else:
            load_dtype = torch.float32
        attn_impl = os.environ.get("NSPEECH_VIBEVOICE_ATTN", "sdpa")

        self._model = VibeVoiceForConditionalGenerationInference.from_pretrained(
            model_path,
            torch_dtype=load_dtype,
            device_map=self.device,
            attn_implementation=attn_impl,
        )

        self._processor = VibeVoiceProcessor.from_pretrained(model_path)
        self._model.eval()
        self._model.set_ddpm_inference_steps(10)
        print("VibeVoice loaded.")

    @property
    def model(self):
        self._load_model()
        return self._model

    @property
    def processor(self):
        self._load_model()
        return self._processor

    def _voice_wav_path(self, voice_name: str) -> Path:
        return self.cache_dir / f"{voice_name}.wav"

    def load_voice(self, voice_name: str, **kwargs) -> None:
        """Validate that reference audio exists for this voice."""
        wav_path = self._voice_wav_path(voice_name)
        if not wav_path.exists():
            raise FileNotFoundError(
                f"VibeVoice voice '{voice_name}' missing reference audio: {wav_path}"
            )

    def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]:
        """
        Generate speech from text using VibeVoice.

        VibeVoice is a batch generator — it produces the entire audio in one
        pass. No streaming, no chunking. The full text is processed together
        so the LLM can understand context and dialogue flow.

        Text format for multi-speaker:
            "Speaker 1: Hello there.\nSpeaker 2: Hi, how are you?"

        For single-speaker (simple TTS), the voice_name is used as the
        speaker label and the text is wrapped automatically.

        Engine-specific kwargs:
            cfg_scale: classifier-free guidance (default 1.3).
            disable_prefill: skip voice cloning, use default voice (default False).
        """
        voice_name = kwargs.get("voice_name", "default")
        cfg_scale = kwargs.get("cfg_scale", 1.3)
        disable_prefill = kwargs.get("disable_prefill", False)

        # VibeVoice script format is strictly "Speaker N: text" (numeric IDs).
        # If the caller passed raw text (no speaker labels), wrap as Speaker 1.
        if not re.match(r"^\s*Speaker\s+\d+\s*:", text, re.IGNORECASE):
            script = f"Speaker 1: {text}"
        else:
            script = text

        # Resolve voice samples
        voice_wav = str(self._voice_wav_path(voice_name))
        voice_samples = [voice_wav] if not disable_prefill else []

        # Prepare inputs
        inputs = self.processor(
            text=[script],
            voice_samples=[voice_samples] if voice_samples else [None],
            padding=True,
            return_tensors="pt",
            return_attention_mask=True,
        )

        # Move to device
        for k, v in inputs.items():
            if torch.is_tensor(v):
                inputs[k] = v.to(self.device)

        # Generate
        outputs = self.model.generate(
            **inputs,
            max_new_tokens=None,
            cfg_scale=cfg_scale,
            tokenizer=self.processor.tokenizer,
            generation_config={"do_sample": False},
            verbose=False,
            is_prefill=not disable_prefill,
        )

        # Output is 24kHz tensor
        if not outputs.speech_outputs or outputs.speech_outputs[0] is None:
            raise RuntimeError(
                f"VibeVoice produced no audio output. Text: {text[:120]}..."
            )

        pcm = outputs.speech_outputs[0].detach().float().cpu().flatten()
        yield pcm, True

    def list_voices(self) -> list:
        """VibeVoice has no native voice catalog — all voices are user-created."""
        return []

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]:
        """
        Create a voice from reference audio.
        VibeVoice uses the reference audio directly at inference time —
        no embedding extraction. We just copy the wav to the voice directory.
        """
        start_time = time.time()

        dest_wav = self._voice_wav_path(voice_name)

        # Pre-resample to 24kHz mono 16-bit for reliability
        import soundfile as sf
        import numpy as np
        try:
            data, sr = sf.read(audio_path)
        except Exception as e:
            raise RuntimeError(f"Cannot read audio for voice clone: {e}")
        if data.ndim > 1:
            data = data.mean(axis=1)
        if sr != 24000:
            from scipy.signal import resample
            num_samples = int(len(data) * 24000 / sr)
            data = resample(data, num_samples).astype("float32")
        sf.write(str(dest_wav), data, 24000, subtype="PCM_16")

        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name,
            "engine": self.engine_name,
            "cache_file": str(dest_wav),
            "source_file": dest_wav.name,
            "clone_time_ms": clone_time_ms,
        }

    def is_loaded(self) -> bool:
        return self._model is not None

    def unload(self) -> None:
        """Release VibeVoice model and processor, free VRAM."""
        self._model = None
        self._processor = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
