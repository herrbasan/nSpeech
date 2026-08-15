"""Probe: does parakeet-tdt pipeline support return_timestamps='word'?

Runs on CPU against a 12s slice of real chunk audio. Read-only — does not
touch the running nVoice service.
"""
import soundfile as sf
from transformers import pipeline

pipe = pipeline('automatic-speech-recognition', model='nvidia/parakeet-tdt-0.6b-v3', device='cpu')
audio, sr = sf.read(r'D:\DEV\nSpeech\logs\chunk-test\parts\probe-12s.wav', dtype='float32')
print(f'audio: {len(audio)/sr:.1f}s @ {sr}Hz')

r1 = pipe(audio)
print('no-arg:', type(r1).__name__, '| keys:', list(r1.keys()) if isinstance(r1, dict) else repr(r1)[:80])

try:
    r2 = pipe(audio, return_timestamps='word')
    chunks = r2.get('chunks', []) if isinstance(r2, dict) else r2
    print("return_timestamps='word': OK | chunks:", len(chunks) if hasattr(chunks, '__len__') else '?')
    for c in list(chunks)[:4]:
        print('  ', c)
except Exception as e:
    print("return_timestamps='word' FAILED:", type(e).__name__, str(e)[:200])
