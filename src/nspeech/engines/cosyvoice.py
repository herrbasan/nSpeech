"""
CosyVoice TTS Engine Adapter
Implements zero-shot multilingual voice cloning via CosyVoice3.
Uses instruct2 for emotions/languages, zero_shot for basic synthesis.

Benchmarks (RTX 5090, CosyVoice3-0.5B):
  Load: ~11s, TTFA: 1450-2000ms, RTF: 0.50-0.62, Clone: ~570ms
"""
import os
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

        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self.default_prompt_wav = str(cosyvoice_dir / "asset" / "zero_shot_prompt.wav")
        if not Path(self.default_prompt_wav).exists():
            self.default_prompt_wav = ""

        self._current_voice = None
        self._current_instruct = None

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
        self._current_voice = voice_name

    def clone(self, audio_path, voice_name, **kwargs):
        start_time = time.time()

        wav, sr = torchaudio.load(audio_path)
        if sr != 16000:
            resampler = torchaudio.transforms.Resample(sr, 16000)
            wav = resampler(wav)

        max_samples = 30 * 16000
        if wav.shape[1] > max_samples:
            wav = wav[:, :max_samples]

        import tempfile
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            torchaudio.save(tmp.name, wav, 16000)
            prompt_text = "You are a helpful assistant.<|endofprompt|>"
            self.model.add_zero_shot_spk(prompt_text, tmp.name, voice_name)
        finally:
            tmp.close()
            os.unlink(tmp.name)

        spk_data = self.model.frontend.spk2info[voice_name]
        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.pt"
        torch.save(spk_data, cache_path)

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

        if instruct_text:
            _prompt = f"{instruct_text}<|endofprompt|>"
        elif language and language != "en":
            _prompt = f"Speak in {language}.<|endofprompt|>"
        else:
            _prompt = "You are a helpful assistant.<|endofprompt|>"

        chunk_gen = self.model.inference_instruct2(
            tts_text=text, instruct_text=_prompt, prompt_wav=prompt_wav,
            zero_shot_spk_id=spk_id, stream=True, speed=_speed,
        )

        for chunk in chunk_gen:
            pcm = chunk["tts_speech"].squeeze()
            if pcm.numel() == 0:
                continue
            yield pcm.cpu(), False

    def _resolve_voice(self, voice_name):
        if voice_name and voice_name != "default":
            if self._current_voice != voice_name:
                self.load_voice(voice_name)
            return voice_name, ""

        if self._current_voice:
            return self._current_voice, ""

        if self.default_prompt_wav:
            return "", self.default_prompt_wav

        raise ValueError(
            "CosyVoice3 has no built-in voices and no default prompt wav. "
            "Clone a voice first via POST /voices/clone with reference audio."
        )
