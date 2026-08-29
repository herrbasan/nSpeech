"""One-shot: patch BigVGAN cwd-relative imports to third_party.BigVGAN.* (F5-TTS convention).
Also replaces the meldataset import with a literal (avoids librosa dependency chain)."""
from pathlib import Path

ROOT = Path("venv/f5tts/env/Lib/site-packages/third_party/BigVGAN")

def patch(rel, old, new):
    p = ROOT / rel
    s = p.read_text(encoding="utf-8")
    assert old in s, f"{rel}: pattern not found: {old!r}"
    p.write_text(s.replace(old, new, 1), encoding="utf-8")
    print(f"patched {rel}")

patch("bigvgan.py", "import activations\nfrom utils import init_weights, get_padding\nfrom alias_free_activation.torch.act import Activation1d as TorchActivation1d\nfrom env import AttrDict",
      "from third_party.BigVGAN import activations\nfrom third_party.BigVGAN.utils import init_weights, get_padding\nfrom third_party.BigVGAN.alias_free_activation.torch.act import Activation1d as TorchActivation1d\nfrom third_party.BigVGAN.env import AttrDict")
patch("utils.py", "from meldataset import MAX_WAV_VALUE", "MAX_WAV_VALUE = 32768  # literal (upstream: meldataset — avoids librosa chain)")
patch("alias_free_activation/torch/act.py", "from alias_free_activation.torch.resample import UpSample1d, DownSample1d",
      "from third_party.BigVGAN.alias_free_activation.torch.resample import UpSample1d, DownSample1d")
print("all patched")
