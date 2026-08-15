"""Probe: uroman output forms for DE/EN edge cases (quotes via file to avoid shell quoting)."""
from uroman import Uroman

u = Uroman()
cases = ['Zähne', 'Straße', 'München', 'Korridore', 'begin.', 'naïve', 'AEther',
         '杜甫', 'café', "don't", 'hello—world', 'end…']
for t in cases:
    print(repr(t), '→', repr(u.romanize_string(t)))
