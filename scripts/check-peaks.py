import soundfile as sf
import numpy as np

for f in ['logs/german-melon-de-f5german.wav', 'logs/german-melon-de-bigvgan.wav',
          'logs/german-melon-de-bigvgan-warm.wav', 'logs/german-melon-de-bigvgan-warm16.wav']:
    d, sr = sf.read(f)
    print(f"{f}: peak={np.abs(d).max():.3f} rms={np.sqrt((d**2).mean()):.4f} clip%={100*np.mean(np.abs(d)>0.99):.2f}")
