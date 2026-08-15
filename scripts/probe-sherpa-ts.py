"""Probe: sherpa-onnx nemo_transducer word timestamps via decode_stream.

sherpa docs claim OfflineRecognizer supports timestamps. Check whether
stream.result exposes word/timestamps after decode_stream on the local
parakeet int8 model. CPU only — does not touch the running nVoice service.
"""
import sys
sys.path.insert(0, r'D:\DEV\nVoice\src')

import numpy as np
import soundfile as sf
import sherpa_onnx
from pathlib import Path

model_dir = Path(r'D:\DEV\nVoice\models\sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
enc = next(model_dir.glob('*encoder*'))
dec = next(model_dir.glob('*decoder*'))
joi = next(model_dir.glob('*joiner*'))
tok = next(model_dir.glob('*tokens*.txt'))
print('model files:', enc.name, dec.name, joi.name, tok.name)

rec = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=str(enc), decoder=str(dec), joiner=str(joi), tokens=str(tok),
    num_threads=4, provider='cpu', model_type='nemo_transducer', debug=False,
)

audio, sr = sf.read(r'D:\DEV\nSpeech\logs\chunk-test\parts\probe-12s.wav', dtype='float32')
print(f'audio: {len(audio)/sr:.1f}s')

stream = rec.create_stream()
stream.accept_waveform(sr, audio.tolist())
rec.decode_stream(stream)

r = stream.result
print('result type:', type(r).__name__)
print('text:', r.text[:100])
print('result attrs:', [n for n in dir(r) if not n.startswith('_')])
for attr in ('timestamps', 'words', 'tokens'):
    if hasattr(r, attr):
        v = getattr(r, attr)
        print(f'{attr}:', (v[:5] if isinstance(v, (list, tuple)) else str(v)[:80]))
