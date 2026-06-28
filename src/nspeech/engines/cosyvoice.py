"""
CosyVoice TTS Engine Adapter
Implements zero-shot multilingual voice cloning via CosyVoice3.

Uses inference_instruct2 for all generation paths with per-sentence chunking.
text_frontend=False bypasses wetext normalization. Sliding window disabled
on Qwen3 backbone for stable attention (RTX 5090 pyTorch nightly).

Adapter conventions:
- generate(): yields (pcm_tensor, is_final) per sentence chunk
- clone(): extracts speaker embedding, saves spk2info as .pt cache
- load_voice(): restores spk2info from .pt cache to model memory
"""
import os
import re
import sys
import time
from pathlib import Path

import soundfile
import torch
import torchaudio
from nspeech import config

os.environ["NUMBA_DISABLE_JIT"] = "1"

import torchaudio  # noqa: E402

torch.backends.cuda.enable_flash_sdp(False)
torch.backends.cuda.enable_mem_efficient_sdp(False)
torch.backends.cuda.enable_math_sdp(True)

def _sf_load(uri, *args, **kwargs):
    data, sr = soundfile.read(uri)
    speech = torch.from_numpy(data.astype("float32")).unsqueeze(0)
    return speech, sr

def _sf_save(uri, src, sample_rate, **kwargs):
    src = src.detach().cpu().numpy().T
    soundfile.write(uri, src, samplerate=sample_rate, format="WAV")

torchaudio.load = _sf_load
torchaudio.save = _sf_save


class CosyvoiceAdapter:
    """TTS engine adapter for CosyVoice3."""

    def __init__(self):
        self.engine_name = "cosyvoice"

        model_dir = Path(config.NSPEECH_MODEL_DIR)
        cosyvoice_dir = model_dir / "CosyVoice"
        matcha_dir = cosyvoice_dir / "third_party" / "Matcha-TTS"

        for p in [str(cosyvoice_dir), str(matcha_dir)]:
            if p not in sys.path:
                sys.path.insert(0, p)

        _model_path = model_dir / "pretrained_models" / "Fun-CosyVoice3-0.5B"
        if not _model_path.exists():
            raise FileNotFoundError(
                f"CosyVoice3 model not found at {_model_path}\n"
                f"Run: python install.py install --engine cosyvoice --models"
            )

        from cosyvoice.cli.cosyvoice import AutoModel

        self.model = AutoModel(model_dir=str(_model_path))
        self.sample_rate = self.model.sample_rate

        self.model.model.llm.llm.model.config.use_sliding_window = False

        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self.default_prompt_wav = str(cosyvoice_dir / "asset" / "zero_shot_prompt.wav")
        if not Path(self.default_prompt_wav).exists():
            self.default_prompt_wav = ""

        self._current_voice = None
        self._current_instruct = None
        self._prompt_wav_path = None

    def load_voice(self, voice_name):
        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.pt"
        if not cache_path.exists():
            raise FileNotFoundError(f"Voice cache not found: {voice_name}")
        spk_data = torch.load(cache_path, weights_only=False, map_location="cpu")
        device = self.model.frontend.device
        for k, v in spk_data.items():
            if isinstance(v, torch.Tensor):
                spk_data[k] = v.to(device)
        self.model.frontend.spk2info[voice_name] = spk_data
        # Restore the original prompt wav path so generate() can locate it
        if "prompt_wav_path" in spk_data:
            self._prompt_wav_path = spk_data["prompt_wav_path"]
        self._current_voice = voice_name

    def _transcribe(self, audio_path):
        """Auto-transcribe reference audio via nVoice STT service.

        Used when no prompt_text is provided to clone(). CosyVoice zero-shot
        cloning needs an accurate transcript of the reference audio for best
        quality — a wrong/generic transcript degrades the speaker embedding.
        """
        stt_url = os.environ.get("NSPEECH_STT_URL", "")
        if not stt_url:
            return ""
        try:
            import ssl
            import urllib.request
            import json as _json
            with open(audio_path, "rb") as f:
                audio_bytes = f.read()
            url = stt_url.rstrip("/") + "/transcribe"
            req = urllib.request.Request(
                url,
                data=audio_bytes,
                headers={"Content-Type": "application/octet-stream"},
            )
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                result = _json.loads(resp.read())
            segments = result.get("segments", [])
            text = " ".join(s.get("text", "") for s in segments).strip()
            return text
        except Exception as e:
            print(f"STT transcription failed: {e}")
            return ""

    def clone(self, audio_path, voice_name, **kwargs):
        start_time = time.time()

        wav, sr = torchaudio.load(audio_path)
        if sr != 16000:
            resampler = torchaudio.transforms.Resample(sr, 16000)
            wav = resampler(wav)

        # CosyVoice hard-crashes on audio >30s (assertion in speech token
        # extraction). Truncate to 30s at 16kHz.
        max_samples = 30 * 16000
        if wav.shape[1] > max_samples:
            wav = wav[:, :max_samples]
        # Persist a 16kHz copy of the prompt wav so re-loads can locate it
        prompt_wav_path = self.cache_dir / f"{voice_name}.wav"
        torchaudio.save(str(prompt_wav_path), wav, 16000)

        prompt_text = kwargs.get("prompt_text") or ""
        # Auto-transcribe via nVoice STT if no prompt_text provided.
        # CosyVoice zero-shot cloning needs an accurate transcript — without it,
        # the speaker embedding quality degrades significantly.
        if not prompt_text:
            prompt_text = self._transcribe(str(prompt_wav_path))
        if not prompt_text:
            prompt_text = "You are a helpful assistant."
        if not prompt_text.endswith("<|endofprompt|>"):
            prompt_text = f"{prompt_text}<|endofprompt|>"
        self.model.add_zero_shot_spk(prompt_text, str(prompt_wav_path), voice_name)

        spk_data = self.model.frontend.spk2info[voice_name]
        # Store prompt_wav_path inside the spk2info dict so load_voice can find it
        spk_data["prompt_wav_path"] = str(prompt_wav_path)
        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.pt"
        torch.save(spk_data, cache_path)

        self._prompt_wav_path = str(prompt_wav_path)
        self._current_voice = voice_name
        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name,
            "engine": self.engine_name,
            "cache_file": str(cache_path),
            "clone_time_ms": clone_time_ms,
        }

    def generate(self, text, voice_name=None, instruct_text=None, language=None, speed=None, exaggeration=None, **kwargs):
        _speed = speed if speed is not None else 1.0
        spk_id, prompt_wav = self._resolve_voice(voice_name)

        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
        if not sentences:
            sentences = [text]

        if instruct_text:
            _prompt = f"{instruct_text}<|endofprompt|>"
        elif language and language != "en":
            _prompt = f"Speak in {language}.<|endofprompt|>"
        else:
            _prompt = "You are a helpful assistant.<|endofprompt|>"

        for sentence in sentences:
            saved_prompt = None
            saved_prompt_len = None
            if spk_id and (instruct_text or (language and language != "en")):
                spk = self.model.frontend.spk2info[spk_id]
                saved_prompt = spk.get("prompt_text")
                saved_prompt_len = spk.get("prompt_text_len")
                prompt_token, prompt_token_len = self.model.frontend._extract_text_token(_prompt)
                spk["prompt_text"] = prompt_token
                spk["prompt_text_len"] = prompt_token_len

            try:
                chunk_gen = self.model.inference_instruct2(
                    tts_text=sentence, instruct_text=_prompt, prompt_wav=prompt_wav,
                    zero_shot_spk_id=spk_id, stream=False, speed=_speed,
                    text_frontend=False,
                )
                for chunk in chunk_gen:
                    pcm = chunk["tts_speech"].squeeze()
                    if pcm.numel() == 0:
                        continue
                    yield pcm.cpu(), False
            finally:
                if saved_prompt is not None:
                    self.model.frontend.spk2info[spk_id]["prompt_text"] = saved_prompt
                    self.model.frontend.spk2info[spk_id]["prompt_text_len"] = saved_prompt_len

    def list_voices(self) -> list:
        """CosyVoice has no native voice catalog — all voices are user-cloned.
        Return [] so the worker falls through to its directory-scan fallback."""
        return []

    def _resolve_voice(self, voice_name):
        if voice_name and voice_name != "default":
            if self._current_voice != voice_name:
                self.load_voice(voice_name)
            prompt_wav = self._prompt_wav_path or self.default_prompt_wav
            return voice_name, prompt_wav

        if self._current_voice:
            prompt_wav = self._prompt_wav_path or self.default_prompt_wav
            return self._current_voice, prompt_wav

        if self.default_prompt_wav:
            return "", self.default_prompt_wav

        raise ValueError(
            "CosyVoice3 has no built-in voices and no default prompt wav. "
            "Clone a voice first via POST /voices/clone with reference audio."
        )
