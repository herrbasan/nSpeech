"""Probe 2: parakeet word timestamps via generation output or model.forward pass.

The pipeline post-processor crashes on return_timestamps='word' (TypeError
inside transformers). Bypass it: run the underlying model and read the
TDT timestamps directly, or check what generate() returns raw.
"""
import soundfile as sf
import torch
from transformers import ParakeetTDTForCTC, AutoProcessor

MODEL = 'nvidia/parakeet-tdt-0.6b-v3'

audio, sr = sf.read(r'D:\DEV\nSpeech\logs\chunk-test\parts\probe-12s.wav', dtype='float32')
print(f'audio: {len(audio)/sr:.1f}s @ {sr}Hz')

processor = AutoProcessor.from_pretrained(MODEL)
model = ParakeetTDTForCTC.from_pretrained(MODEL)
model.eval()

inputs = processor(audio, sampling_rate=16000, return_tensors='pt')
print('input keys:', list(inputs.keys()))

with torch.no_grad():
    logits = model(inputs.input_features).logits
print('logits shape:', tuple(logits.shape))

# CTC path: greedy decode → per-token timestamps are frame-indexed.
# 8ms per encoder frame for NeMo TDT-style frontends; check processor for the
# true hop before trusting offsets.
pred_ids = torch.argmax(logits, dim=-1)
uniq = torch.unique_consecutive(pred_ids).squeeze(0)
frames = uniq.nonzero().squeeze(-1)
print('unique tokens:', len(frames))
toks = processor.tokenizer.convert_ids_to_tokens(uniq.tolist())
print('first 12 toks:', toks[:12])
print('frame indices (first 12):', frames[:12].tolist())
print('encoder stride: logits frames / audio sec =', logits.shape[1] / (len(audio)/sr))
