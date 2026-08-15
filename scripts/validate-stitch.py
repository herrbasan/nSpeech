"""Final E2E validation: transcribe the ENTIRE stitched output and compare
against the source text. Verifies: no duplicated overlap, no missing content,
correct stitch order. Runs sherpa on CPU — no quota, no GPU conflict.
"""
import sys
sys.path.insert(0, r'D:\DEV\nVoice\src')

import sherpa_onnx
from pathlib import Path

md = Path(r'D:\DEV\nVoice\models\sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
rec = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=str(next(md.glob('*encoder*'))),
    decoder=str(next(md.glob('*decoder*'))),
    joiner=str(next(md.glob('*joiner*'))),
    tokens=str(next(md.glob('*tokens*.txt'))),
    num_threads=4, provider='cpu', model_type='nemo_transducer', debug=False,
)

import soundfile as sf
audio, sr = sf.read(r'D:\DEV\nSpeech\logs\chunk-test\parts\stitched-16k.wav', dtype='float32')
print(f'stitched audio: {len(audio)/sr:.1f}s')

# Transducer has a chunk length limit (broadcast error on >~60s). Split on
# 30s windows with 1s overlap and concatenate text — positions don't matter,
# we only check content presence at the join.
import re as _re
pieces = []
win = 30 * sr
hop = 29 * sr
for off in range(0, len(audio), hop):
    seg = audio[off:off + win]
    if len(seg) < sr // 2:  # skip tiny tail covered by previous window
        break
    s = rec.create_stream()
    s.accept_waveform(sr, seg.tolist())
    rec.decode_stream(s)
    pieces.append(s.result.text)
heard = ' '.join(pieces)

print(f'heard {len(heard.split())} words (source: 1015)')

# Boundary check: last words of chunk 1 → first words of chunk 2 must be adjacent
import re
src = open(r'D:\DEV\nSpeech\logs\chunk-test\input-text.txt', encoding='utf-8').read()
paras = [p.strip() for p in re.split(r'\n\s*\n', src) if p.strip()]
j1 = paras[8].split()[-1]        # last word of chunk 1 ("fact.")
j2 = paras[9].split()[0]         # first word of chunk 2 ("There")
print(f'source join: ...{paras[8].split()[-3]} {paras[8].split()[-2]} {j1} | {j2} {paras[9].split()[1]}...')

# find the join in the transcript
pat = re.escape(j1)
m = re.search(pat + r'\s+' + re.escape(j2), heard)
print('join found in transcript:', bool(m))
if m:
    print('  context:', heard[max(0, m.start()-60):m.end()+60])

# check for duplicated overlap (the word "Begin." should appear exactly as in source)
begin_count_src = len(re.findall(r'\bBegin\b', src))
begin_count_heard = len(re.findall(r'\bBegin\b', heard))
print(f'"Begin" occurrences: source={begin_count_src}, heard={begin_count_heard} {"OK" if begin_count_src == begin_count_heard else "OVERLAP LEAKED"}')
