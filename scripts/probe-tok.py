"""Probe: tokenize romanized forms through MMS tokenizer."""
from torchaudio.pipelines import MMS_FA as bundle

tok = bundle.get_tokenizer()
for t in ['zaehne', 'strasse', 'muenchen', 'dufu', 'cafe', 'begin.', 'ae']:
    try:
        print(repr(t), '→', tok([t])[0])
    except KeyError as e:
        print(repr(t), '→ KeyError', e)
